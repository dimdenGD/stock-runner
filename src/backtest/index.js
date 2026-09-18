import { formatDate } from '../utils.js';
import Broker from '../brokers/base.js';
import { splitPositionOrder } from '../brokers/orderLegs.js';
import RunJournal from '../journal.js';
import CandleBuffer from './candleBuffer.js';
import Strategy from './strategy.js';
import { loadFundingInRange } from './loader.js';
import { intervalMsMap, markets } from './consts.js';
import chalk from 'chalk';
import { formatSwapLine, formatTradeLine } from './logFormat.js';
import { runAllTickersStream } from './multiIntervalStream.js';

const sharpePeriods = {
    '1d': 252,
    '4h': 252 * 1.625, // 6.5 trading hours per day
    '1h': 252 * 6.5,   // 6.5 trading hours per day
    '15m': 252 * 26,   // 26 fifteen-min bars per 6.5h day
    '5m': 252 * 78,    // 78 five-min bars per 6.5h day
    '1m': 252 * 390,   // 390 minutes in a trading day
}

const cryptoSharpePeriods = Object.fromEntries(
    Object.entries(intervalMsMap).map(([name, ms]) => [name, 365 * 86400000 / ms])
);

const oneStockChunkBars = {
    '1d': 600,
    '4h': 1000,
    '1h': 2000,
    '15m': 3000,
    '5m': 5000,
    '1m': 10000,
}

function pearsonCorrelation(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const meanX = sumX / n;
    const meanY = sumY / n;
    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - meanX;
        const dy = ys[i] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
    }
    const den = Math.sqrt(denX * denY);
    return den === 0 ? null : num / den;
}

/**
 * Backtest orchestrator: runs a Strategy instance, records equity over time,
 * and computes performance statistics.
 */
export default class Backtest {
    /**
     * @param {Object} params
     * @param {Object} params.strategy            – Strategy instance
     * @param {string} params.stockName           – Ticker symbol
     * @param {Date}   params.startDate           – Backtest start
     * @param {Date}   params.endDate             – Backtest end
     * @param {number} params.capital             – Starting cash balance
     */
    constructor({ strategy, startDate, endDate, capital, broker = new Broker(), logs = {}, features = [], market, allowShort, maxLeverage,
        journal = null, journalFile = 'output/journal.sqlite', journalTicks = 'daily', strategySourcePath = null }) {
        if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
            throw new TypeError('startDate and endDate must be instances of Date');
        }
        if (typeof capital !== 'number' || !(capital > 0)) {
            throw new TypeError('capital must be a positive number');
        }
        if (!(strategy instanceof Strategy)) {
            throw new TypeError('strategy must be an instance of Strategy');
        }
        if(!(broker instanceof Broker)) {
            throw new TypeError('broker must be an instance of Broker');
        }
        
        this.strategy = strategy;
        this.startDate = startDate;
        this.endDate = endDate;
        this.warmupStart = new Date(startDate.getTime() - strategy.warmup * intervalMsMap[strategy.mainInterval.name]);
        this.isWarmup = false;

        this.capital = capital;
        this.cashBalance = capital;
        this.stockBalances = {};
        this.holdSince = {};
        this.stockPrices = {};

        this.swaps = [];
        this.trades = [];
        this.equityCurve = [];
        this.delistCounter = {};
        this.stockFeatures = {};  // features set at buy, cleared when position closed

        this.broker = broker;
        this.totalFees = 0;
        this.buffers = {};

        this.logs = logs;
        this.featuresDef = features;

        market = market ?? broker.market ?? 'stocks';
        if (!markets.includes(market)) {
            throw new TypeError(`market must be one of: ${markets.join(', ')}`);
        }
        this.market = market;
        this.allowShort = allowShort ?? market === 'crypto';
        this.maxLeverage = maxLeverage ?? (market === 'crypto' ? 3 : null);
        this.positions = {};      // stockName -> { avgPrice, entryFees }
        this.totalFunding = 0;    // funding paid (+) or received (-)
        this.skippedOrders = 0;   // rejected by exchange lot/notional minimums
        this.skippedNotional = 0;
        this.quantizedOrders = 0; // filled, but rounded down to a lot boundary
        this.quantizedDrift = 0;
        this.fundingEvents = null;
        this.fundingCursor = {};
        this.lastSeen = {};       // crypto: stockName -> timestamp of its last candle
        this.ruined = false;
        this.journal = journal === false ? null
            : journal instanceof RunJournal ? journal
            : new RunJournal({ file: journalFile });
        this.ownsJournal = this.journal != null && !(journal instanceof RunJournal);
        this.journalTicks = journalTicks;
        this.strategySourcePath = strategySourcePath;
        this.runId = null;
        this._valuationVersion = 0;
        this._totalValueCache = null;
        this._grossExposureCache = null;
    }

    async runOnTicker(stockName) {
        await this.broker.prepareBacktest();
        this._beginJournal();
        if(!this.buffers[stockName]) {
            this.buffers[stockName] = {};
        }
        const buffers = this.buffers[stockName];
        // Initialize every declared interval so getCandles has the same behavior for each one.
        for(let iv in this.strategy.intervals) {
            const interval = this.strategy.intervals[iv];
            buffers[interval.name] = new CandleBuffer(stockName, interval.name, this.warmupStart, this.endDate, interval.count, oneStockChunkBars[interval.name], this.market);
        }
        // Load the initial chunks.
        await Promise.all(
            Object.values(buffers).map(buf => buf.ensure(this.warmupStart))
        );
        const mainBuf = buffers[this.strategy.mainInterval.name].buffer;
        const lookback = this.strategy.mainInterval.count;
        const getCandles = (ts, intervalName, count) => {
            const interval = this.strategy.intervals[intervalName];
            if(!interval) {
                throw new Error(`Interval ${intervalName} not found. You need to request it in the strategy constructor.`);
            }
            const candles = buffers[intervalName].getLast(count, ts);
            if(candles.length < count) {
                return null;
            }
            return candles;
        };

        if (this.market === 'crypto') {
            this.fundingEvents = await loadFundingInRange(new Date(this.warmupStart.getTime() - 86400000), this.endDate);
        }
        let prevTs = null;

        // iterate once we have full lookback
        for (let i = lookback - 1; i < mainBuf.length; i++) {
            const mainCandle = mainBuf[i];
            const ts = mainCandle.timestamp;
            if (ts >= this.endDate) break;
            this.isWarmup = this.strategy.warmup > 0 && ts < this.startDate.getTime();

            // top up all buffers as we advance
            const fetches = Object.values(buffers)
                .filter(buf => buf.needsFetch(ts))
                .map(buf => buf.ensure(ts));
            if (fetches.length) await Promise.all(fetches);

            this._markPrice(stockName, mainCandle.close);
            if (this.market === 'crypto') {
                this.applyFunding(prevTs ?? ts, ts);
                prevTs = ts;
            }

            const tickObj = {
                stockName,
                candle: mainCandle,
                ctx: this,
                stockBalance: this.stockBalances[stockName] || 0,
                _features: null,
                features: this.stockFeatures[stockName] ?? null,
                setFeatures(features) { this._features = features; },
                getCandles: (intervalName, count, ts = mainCandle.timestamp) => {
                    if(ts > mainCandle.timestamp) {
                        throw new Error(`Requested candles in the future: ${ts} > ${mainCandle.timestamp}`);
                    }
                    return getCandles(ts, intervalName, count);
                },
                buy: (quantity, price) => this.buy(stockName, quantity, price, mainCandle.timestamp, tickObj._features, mainCandle),
                sell: (quantity, price) => this.sell(stockName, quantity, price, mainCandle.timestamp, mainCandle),
            };
            await this.strategy.onTick(tickObj);

            if (!this.isWarmup) this.equityCurve.push([mainCandle.timestamp, this.totalValue(), this.cashBalance]);
        }

        const metrics = this.getMetrics();
        this._endJournal(metrics);
        return metrics;
    }

    async runOnAllTickers() {
        await this.broker.prepareBacktest();
        this._beginJournal();
        try {
            const metrics = await runAllTickersStream(this);
            this._endJournal(metrics);
            return metrics;
        } catch (err) {
            this._endJournal(null, err);
            throw err;
        }
    }

    _beginJournal() {
        if (!this.journal) return;
        this.runId = this.journal.startRun({
            strategy: this.strategy.name,
            broker: this.broker.label,
            account: this.broker.account,
            dryRun: 0,
            mode: 'backtest',
            strategyVersionId: this.journal.strategyVersion({
                name: this.strategy.name,
                market: this.market,
                sourcePath: this.strategySourcePath ?? this.strategy.sourcePath ?? null,
                params: this.strategy.params,
            }),
            market: this.market,
            capital: this.capital,
            interval: this.strategy.mainInterval.name,
            windowStart: +this.startDate,
            windowEnd: +this.endDate,
            config: {
                params: this.strategy.params,
                warmup: this.strategy.warmup,
                allowShort: this.allowShort,
                maxLeverage: this.maxLeverage,
            },
        });
        this.journal.snapshot(this.runId, +this.startDate, 'start', { cash: this.capital, equity: this.capital, positions: [] });
        this.journal.batchBegin();
    }

    _endJournal(metrics, error = null) {
        if (!this.journal || this.runId == null) return;
        this._writeJournalTicks();
        const positions = Object.entries(this.stockBalances)
            .filter(([, q]) => q)
            .map(([symbol, quantity]) => ({
                symbol, quantity,
                markPrice: this.stockPrices[symbol],
                entryPrice: this.positions[symbol]?.avgPrice ?? null,
            }));
        this.journal.batchEnd();
        this.journal.snapshot(this.runId, +this.endDate, 'end', {
            cash: this.cashBalance, equity: this.totalValue(), positions,
        }, this.stockPrices);
        this.journal.finishRun(this.runId, { finalEquity: this.totalValue(), metrics });
        this.journal.endRun(this.runId, error ? 'error' : 'complete', error);
        if (this.ownsJournal) this.journal.close();
        this.runId = null;
    }

    _writeJournalTicks() {
        if (!this.journal || this.journalTicks === false || !this.equityCurve.length) return;
        const daily = this.journalTicks !== 'bar';
        let lastDay = null;
        for (const [ts, equity, cash] of this.equityCurve) {
            const t = +ts;
            if (daily) {
                const day = Math.floor(t / 86400000);
                if (day === lastDay) continue;
                lastDay = day;
            }
            this.journal.tick(this.runId, { ts: t, equity, available: cash, status: 'complete' });
            this.journal.batchStep();
        }
    }

    record() {}

    _invalidateValuation() {
        this._valuationVersion++;
    }

    _markPrice(stockName, price) {
        if (this.stockBalances[stockName] && this.stockPrices[stockName] !== price) {
            this._invalidateValuation();
        }
        this.stockPrices[stockName] = price;
    }

    totalValue() {
        if (this._totalValueCache?.version === this._valuationVersion) {
            return this._totalValueCache.value;
        }
        const value = this.cashBalance + Object.entries(this.stockBalances).reduce((acc, [stockName, quantity]) => acc + quantity * this.stockPrices[stockName], 0);
        this._totalValueCache = { version: this._valuationVersion, value };
        return value;
    }

    grossExposure() {
        if (this._grossExposureCache?.version === this._valuationVersion) {
            return this._grossExposureCache.value;
        }
        const value = Object.entries(this.stockBalances).reduce((acc, [stockName, quantity]) => acc + Math.abs(quantity * this.stockPrices[stockName]), 0);
        this._grossExposureCache = { version: this._valuationVersion, value };
        return value;
    }

    applyFunding(fromTs, toTs) {
        if (!this.fundingEvents) return;
        for (const stockName in this.stockBalances) {
            const ev = this.fundingEvents[stockName];
            if (!ev) continue;
            let cursor = this.fundingCursor[stockName];
            if (cursor == null) {
                let lo = 0, hi = ev.time.length;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (ev.time[mid] <= fromTs) lo = mid + 1; else hi = mid; }
                cursor = lo;
            } else {
                while (cursor < ev.time.length && ev.time[cursor] <= fromTs) cursor++;
            }
            for (; cursor < ev.time.length && ev.time[cursor] <= toTs; cursor++) {
                const pay = this.stockBalances[stockName] * this.stockPrices[stockName] * ev.rate[cursor];
                this.cashBalance -= pay;
                this.totalFunding += pay;
                this._invalidateValuation();
            }
            this.fundingCursor[stockName] = cursor;
        }
    }

    settle(stockName, timestamp) {
        const quantity = this.stockBalances[stockName];
        if (!quantity) return;
        console.log(chalk.red(`${stockName} DELISTED - settled at $${this.stockPrices[stockName]} on ${formatDate(new Date(+timestamp))}`));
        this._trade(stockName, -quantity, this.stockPrices[stockName], timestamp, null, null, { settle: true });
    }

    buy(stockName, quantity, price, timestamp, features, candle) {
        this._trade(stockName, quantity, price, timestamp, features, candle);
    }

    sell(stockName, quantity, price, timestamp, candle) {
        this._trade(stockName, -quantity, price, timestamp, null, candle);
    }

    _trade(stockName, signedQty, price, timestamp, features, candle, opts = {}) {
        try {
            return this._executeTrade(stockName, signedQty, price, timestamp, features, candle, opts);
        } catch (err) {
            this._journalOrder(stockName, signedQty, price, timestamp, this.stockBalances[stockName] || 0, 'failed', err.message, candle);
            throw err;
        }
    }

    _journalOrder(stockName, signedQty, price, timestamp, heldQty, status, error, candle) {
        if (!this.journal || this.runId == null) return;
        const ts = +timestamp;
        const side = signedQty > 0 ? 'buy' : 'sell';
        const quantity = Math.abs(signedQty);
        const intentId = this.journal.intent(this.runId, ts, {
            symbol: stockName, signedQty, price, heldQty, sizingEquity: this.totalValue(),
        });
        const orderId = this.journal.insertOrder(this.runId, ts, {
            intentId, symbol: stockName, side, quantity,
            reduceOnly: heldQty !== 0 && Math.sign(signedQty) !== Math.sign(heldQty),
            decisionPrice: price,
        }, status, error);
        if (status === 'filled') {
            this.journal.orderResult(orderId, {
                status: 'filled',
                executedQty: quantity,
                avgPrice: this.broker.executionPrice(quantity, price, side, candle),
            }, null);
        }
        this.journal.batchStep(3);
    }

    _executeTrade(stockName, signedQty, price, timestamp, features, candle, { settle = false } = {}) {
        if (this.isWarmup && !settle) {
            throw new Error(`Orders are not allowed during warm-up: ${stockName}`);
        }
        const side = signedQty > 0 ? 'buy' : 'sell';
        if (!(Math.abs(signedQty) > 0) || !isFinite(signedQty) || !(price > 0)) {
            throw new Error(`Invalid order: ${side} ${Math.abs(signedQty)} ${stockName} @ ${price}`);
        }
        const prev = this.stockBalances[stockName] || 0;

        if (!settle) {
            const requested = signedQty;
            let accepted = 0;
            for (const leg of splitPositionOrder(prev, requested)) {
                accepted += this.broker.quantize(stockName, leg.signedQty, price, { reduceOnly: leg.reduceOnly }) || 0;
            }
            if (!accepted) {
                this.skippedOrders++;
                this.skippedNotional += Math.abs(requested) * price;
                this._journalOrder(stockName, requested, price, timestamp, prev, 'skipped', 'below exchange quantity/notional minimum', candle);
                return;
            }
            if (accepted !== requested) {
                this.quantizedOrders++;
                this.quantizedDrift += Math.abs(requested - accepted) * price;
            }
            signedQty = accepted;
        }
        const quantity = Math.abs(signedQty);

        if (side === 'sell' && !this.allowShort) {
            if (!prev) {
                throw new Error(`Insufficient shares: have 0, trying to sell ${quantity}`);
            }
            if (quantity > prev) {
                throw new Error(`Insufficient shares: have ${prev}, trying to sell ${quantity}`);
            }
        }
        if (this.market === 'crypto' && !settle && candle && !(candle.volume > 0)) {
            throw new Error(`Untradeable: ${stockName} had no volume in this bar`);
        }

        const fee = this.broker.calculateFees(quantity, price, side, candle);
        const notional = quantity * price;
        let next = prev + signedQty;
        if (Math.abs(next) <= 1e-12 * Math.max(1, Math.abs(prev))) next = 0;

        this._markPrice(stockName, price);
        if (this.maxLeverage == null) {
            if (side === 'buy' && notional + fee > this.cashBalance) {
                throw new Error(`Insufficient cash: need ${notional + fee}, have ${this.cashBalance}`);
            }
        } else if (!settle) {
            const grossNow = this.grossExposure();
            const grossAfter = grossNow - Math.abs(prev * price) + Math.abs(next * price);
            const equity = this.totalValue() - fee;
            if (grossAfter > grossNow + 1e-9 && grossAfter > this.maxLeverage * equity) {
                throw new Error(`Insufficient margin: ${stockName} would take gross exposure to $${Math.round(grossAfter)} on $${Math.round(equity)} equity (max ${this.maxLeverage}x)`);
            }
        }

        this.cashBalance += side === 'buy' ? -(notional + fee) : (notional - fee);
        this._invalidateValuation();
        this.totalFees += fee;
        this._journalOrder(stockName, signedQty, price, timestamp, prev, 'filled', null, candle);
        this.swaps.push({ type: side, quantity, price, timestamp, fee, stockName });
        if (this.market === 'crypto' && this.lastSeen[stockName] == null) this.lastSeen[stockName] = +timestamp;

        if (this.logs.swaps) {
            console.log(formatSwapLine({ timestamp, stockName, market: this.market, side, quantity, price, fee, cash: this.cashBalance, equity: this.totalValue() }));
        }

        const pos = this.positions[stockName] ?? { avgPrice: 0, entryFees: 0 };
        const closing = prev !== 0 && Math.sign(signedQty) !== Math.sign(prev);
        const closedQty = closing ? Math.min(quantity, Math.abs(prev)) : 0;

        if (closedQty > 0) {
            const dir = Math.sign(prev);
            const entryFee = pos.entryFees * (closedQty / Math.abs(prev));
            const exitFee = fee * (closedQty / quantity);
            const profit = dir * closedQty * (price - pos.avgPrice) - entryFee - exitFee;
            const profitPercent = profit / (closedQty * pos.avgPrice);
            pos.entryFees -= entryFee;
            const tradeFeatures = this.stockFeatures[stockName];
            this.trades.push({
                stockName, side: dir > 0 ? 'long' : 'short', quantity: closedQty, price, entryPrice: pos.avgPrice,
                timestamp, fee: exitFee, profit, profitPercent, features: tradeFeatures ?? undefined,
            });

            if (this.logs.trades) {
                console.log(formatTradeLine({
                    timestamp, stockName, market: this.market, dir, profit, profitPercent,
                    holdMs: +timestamp - +this.holdSince[stockName],
                    cash: this.cashBalance, equity: this.totalValue(), features: tradeFeatures,
                }));
            }
        }

        const opened = quantity - closedQty;
        if (opened > 0 && next !== 0) {
            const base = closing ? 0 : Math.abs(prev);
            pos.avgPrice = (base * (closing ? 0 : pos.avgPrice) + opened * price) / (base + opened);
            pos.entryFees = (closing ? 0 : pos.entryFees) + fee * (opened / quantity);
            if (base === 0) this.holdSince[stockName] = timestamp;
            if (features != null && Array.isArray(features)) this.stockFeatures[stockName] = features;
        }

        if (next === 0) {
            delete this.stockBalances[stockName];
            delete this.positions[stockName];
            delete this.holdSince[stockName];
            delete this.stockFeatures[stockName];
        } else {
            this.stockBalances[stockName] = next;
            this.positions[stockName] = pos;
        }
        this._invalidateValuation();
    }

    getMetrics() {
        if (this.equityCurve.length < 2) {
            throw new Error('Backtest not run or equityCurve too short');
        }

        /* ---------- equity series & simple returns ---------------------- */
        const series = this.equityCurve.map(e => e[1]);

        const periodRets = [];
        for (let i = 1; i < series.length; i++) {
            periodRets.push(series[i] / series[i - 1] - 1);
        }

        const dayCloses = [[null, this.capital]];
        let lastDay = null;
        for (const [ts, equity] of this.equityCurve) {
            const day = new Date(ts).toISOString().slice(0, 10);
            if (day === lastDay) dayCloses[dayCloses.length - 1][1] = equity;
            else { dayCloses.push([day, equity]); lastDay = day; }
        }
        const dailyRets = [];
        for (let i = 1; i < dayCloses.length; i++) {
            dailyRets.push(dayCloses[i][1] / dayCloses[i - 1][1] - 1);
        }

        /* ---------- totals & CAGR -------------------------------------- */
        const finalEquity  = series.at(-1);
        const totalReturn  = finalEquity / this.capital - 1;
        const years        = (this.endDate - this.startDate) / (365 * 24 * 3600 * 1e3);
        const CAGR         = Math.pow(1 + totalReturn, 1 / years) - 1;

        /* ---------- Sharpe (annualised) -------------------------------- */
        const periodsPerYr = (this.market === 'crypto' ? cryptoSharpePeriods : sharpePeriods)[this.strategy.mainInterval.name] ?? 252;
        const meanRet      = periodRets.reduce((s, r) => s + r, 0) / periodRets.length;
        const stdRet       = Math.sqrt(
            periodRets.reduce((s, r) => s + (r - meanRet) ** 2, 0) / periodRets.length
        );
        const sharpe       = stdRet ? (meanRet / stdRet) * Math.sqrt(periodsPerYr) : 0;

        /* ---------- geometric means ------------------------------------ */
        const geoPeriodRet = Math.exp(
            periodRets.reduce((s, r) => s + Math.log(1 + r), 0) / periodRets.length
        ) - 1;
        const geoAnnualRet = Math.pow(1 + geoPeriodRet, periodsPerYr) - 1;

        /* ---------- max draw-down -------------------------------------- */
        let peak = series[0], maxDD = 0;
        for (const eq of series) {
            if (eq > peak) peak = eq;
            const dd = (eq - peak) / peak;
            if (dd < maxDD) maxDD = dd;
        }

        const avgDaily = dailyRets.length
            ? dailyRets.reduce((s, r) => s + r, 0) / dailyRets.length
            : 0;
        const geoDaily = dailyRets.length
            ? Math.exp(dailyRets.reduce((s, r) => s + Math.log(1 + r), 0) / dailyRets.length) - 1
            : 0;
        const dailyWinRate = dailyRets.length
            ? dailyRets.filter(r => r > 0).length / dailyRets.length
            : 0;
        const days = dailyRets.length;

        /* --------- feature correlations ---------------------------- */
        const tradesWithFeatures = this.trades.filter(t =>
            t.features != null && Array.isArray(t.features) && t.features.length > 0 &&
            typeof t.profit === 'number' && typeof t.profitPercent === 'number'
        );
        let featureCorrelations = null;
        if (tradesWithFeatures.length >= 2) {
            const maxLen = tradesWithFeatures.reduce((max, t) => Math.max(max, t.features.length), 0);
            featureCorrelations = [];
            for (let i = 0; i < maxLen; i++) {
                const valid = tradesWithFeatures.filter(t => t.features.length > i);
                if (valid.length < 2) {
                    featureCorrelations.push(null);
                    continue;
                }
                const xs = valid.map(t => t.features[i]);
                const ys = valid.map(t => t.profitPercent);
                featureCorrelations.push(pearsonCorrelation(xs, ys));
            }
        }

        return {
            period        : [this.startDate, this.endDate],
            trades        : this.trades.length,
            totalFees     : this.totalFees,
            totalReturn,
            avgDaily,
            geoDaily,
            dailyWinRate,
            days,
            CAGR,
            sharpe,
            maxDrawdown   : maxDD,
            geoPeriodRet,
            geoAnnualRet,
            featureCorrelations,
            totalFunding  : this.totalFunding,
            ruined        : this.ruined,
        };
    }

    logMetrics(m) {
        if(Object.keys(this.stockBalances).length > 0) {
            console.log('\n');
            console.log(chalk.bold('=== STOCKS STILL IN PORTFOLIO ==='));
            for(const stockName in this.stockBalances) {
                console.log(`${this.stockBalances[stockName].toLocaleString('en-US').padEnd(8)} ${chalk.bold(stockName.padEnd(7))} ($${(this.stockPrices[stockName] * this.stockBalances[stockName]).toLocaleString('en-US')})`.padEnd(40) + (this.holdSince[stockName] ? ` (held since ${formatDate(this.holdSince[stockName])})` : ''));
            }
        }

        console.log('\n' + chalk.bold('=== BACKTEST SUMMARY ==='));
        console.log(`Period            : ${this.startDate.toISOString().slice(0,10)} → ${this.endDate.toISOString().slice(0,10)}`);
        console.log(`Trades            : ${this.trades.length}  (win-rate ${(this.trades.filter(t => t.profit > 0).length / this.trades.length * 100).toFixed(2)}%) / ${this.swaps.length} swaps`);
        console.log(`Fees              : $${Math.round(this.totalFees).toLocaleString('en-US')}`);
        if (this.market === 'crypto') {
            const funding = Math.round(Math.abs(this.totalFunding)).toLocaleString('en-US');
            console.log(`Funding           : ${this.totalFunding <= 0 ? chalk.greenBright(`received $${funding}`) : chalk.redBright(`paid $${funding}`)}`);
        }
        console.log(`Total USD return  : ${m.totalReturn > 0 ? chalk.greenBright('+$' + (Math.round(m.totalReturn * this.capital)).toLocaleString('en-US')) : chalk.redBright('-$' + Math.abs(Math.round(m.totalReturn * this.capital)).toLocaleString('en-US'))} ($${this.capital.toLocaleString('en-US')} → $${Math.round(this.totalValue()).toLocaleString('en-US')})`);
        console.log(`Total % return    : ${m.totalReturn > 0 ? chalk.greenBright('+' + (m.totalReturn * 100).toFixed(2) + '%') : chalk.redBright('' + (m.totalReturn * 100).toFixed(2) + '%')}`);
        const pctColor = (v, d) => (v > 0 ? chalk.greenBright('+' + (v * 100).toFixed(d) + '%') : chalk.redBright('' + (v * 100).toFixed(d) + '%'));
        console.log(`Avg daily return  : ${pctColor(m.avgDaily, 3)}  (geo ${(m.geoDaily * 100).toFixed(3)}%, ${(m.dailyWinRate * 100).toFixed(1)}% of ${m.days} days up)`);
        console.log(`CAGR (Annualized) : ${m.CAGR > 0 ? chalk.greenBright('+' + (m.CAGR * 100).toFixed(1) + '%') : chalk.redBright('' + (m.CAGR * 100).toFixed(1) + '%')}`);
        console.log(`Geo-mean ${this.strategy.mainInterval.name.padEnd(9)}: ${pctColor(m.geoPeriodRet, 4)}  (annual ≈ ${(m.geoAnnualRet * 100).toFixed(1)}%)`);
        console.log(`Geo-mean annual   : ${m.geoAnnualRet > 0 ? chalk.greenBright('+' + (m.geoAnnualRet * 100).toFixed(2) + '%') : chalk.redBright('' + (m.geoAnnualRet * 100).toFixed(2) + '%')}`);
        
        const maxDrawdownColor = m.maxDrawdown >= -0.025 ? 'cyanBright' : m.maxDrawdown >= -0.1 ? 'greenBright' : m.maxDrawdown >= -0.2 ? 'yellowBright' : m.maxDrawdown >= -0.3 ? 'redBright' : 'red';
        console.log(`Max draw-down     : ${chalk[maxDrawdownColor]((m.maxDrawdown * 100).toFixed(1) + '%')}`);
        const sharpeColor = m.sharpe > 3 ? 'cyanBright' : m.sharpe > 2 ? 'greenBright' : m.sharpe > 1 ? 'yellowBright' : 'redBright';
        console.log(`Sharpe            : ${chalk[sharpeColor](m.sharpe.toFixed(2))}`);
        if (m.featureCorrelations && m.featureCorrelations.length > 0) {
            const parts = m.featureCorrelations.map((r, i) => {
                const v = r == null ? 'n/a' : r.toFixed(3);
                return chalk.cyan(`f${i}: ${v}`);
            });
            console.log(`Feature vs return% : ${parts.join('  ')}`);
        }

        let rank = 'F';
        let rankColor = 'redBright';
        if(m.sharpe >= 3.4 && m.maxDrawdown >= -0.2) {
            rank = 'S';
            rankColor = 'cyanBright';
        } else if(m.sharpe >= 3 && m.maxDrawdown > -0.3) {
            rank = 'A';
            rankColor = 'greenBright';
        } else if(m.sharpe >= 2 && m.maxDrawdown > -0.32) {
            rank = 'B';
            rankColor = 'yellowBright';
        } else if(m.sharpe >= 1.5 && m.maxDrawdown > -0.35) {
            rank = 'C';
            rankColor = 'yellowBright';
        } else if(m.sharpe >= 1 && m.maxDrawdown > -0.4) {
            rank = 'D';
            rankColor = 'redBright';
        } else if(m.maxDrawdown > -0.4) {
            rank = 'E';
            rankColor = 'redBright';
        } else {
            rank = 'F';
            rankColor = 'redBright';
        }
        console.log(chalk.bold(`\nRank              : ${chalk[rankColor](rank)}`));
    }

    buildReport(m) {
        const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

        let rank = 'F', rankColor = '#ff4444', rankGlow = '#ff444480';
        if (m.sharpe >= 3.4 && m.maxDrawdown >= -0.2) {
            rank = 'S'; rankColor = '#00ffff'; rankGlow = '#00ffff60';
        } else if (m.sharpe >= 3 && m.maxDrawdown > -0.3) {
            rank = 'A'; rankColor = '#44ff44'; rankGlow = '#44ff4460';
        } else if (m.sharpe >= 2 && m.maxDrawdown > -0.32) {
            rank = 'B'; rankColor = '#ffff44'; rankGlow = '#ffff4460';
        } else if (m.sharpe >= 1.5 && m.maxDrawdown > -0.35) {
            rank = 'C'; rankColor = '#ffff44'; rankGlow = '#ffff4460';
        } else if (m.sharpe >= 1 && m.maxDrawdown > -0.4) {
            rank = 'D'; rankColor = '#ff4444'; rankGlow = '#ff444460';
        } else if (m.maxDrawdown > -0.4) {
            rank = 'E'; rankColor = '#ff4444'; rankGlow = '#ff444460';
        }

        const maxDDColor = m.maxDrawdown >= -0.025 ? '#00ffff'
            : m.maxDrawdown >= -0.1 ? '#44ff44'
            : m.maxDrawdown >= -0.2 ? '#ffff44'
            : m.maxDrawdown >= -0.3 ? '#ff4444' : '#ff0000';
        const sharpeColor = m.sharpe > 3 ? '#00ffff'
            : m.sharpe > 2 ? '#44ff44'
            : m.sharpe > 1 ? '#ffff44' : '#ff4444';
        const retColor = v => v >= 0 ? '#44ff44' : '#ff4444';

        const winRate = this.trades.length
            ? (this.trades.filter(t => t.profit > 0).length / this.trades.length * 100).toFixed(2)
            : '0.00';
        const finalEquity = Math.round(this.totalValue());

        /* ---- equity + cash curve ---- */
        const sortedEquity = this.equityCurve.toSorted((a, b) => a[0] - b[0]);
        const equityLabels = sortedEquity.map(([ts]) => new Date(ts).toISOString().slice(0, 10));
        const equityValues = sortedEquity.map(([, eq]) => +eq.toFixed(2));
        const cashValues = sortedEquity.map(e => +(e[2] ?? 0).toFixed(2));

        /* ---- avg profit per day ---- */
        const dayMap = {};
        for (const t of this.trades) {
            const day = new Date(t.timestamp).toISOString().slice(0, 10);
            if (!dayMap[day]) dayMap[day] = [];
            dayMap[day].push(t.profitPercent * 100);
        }
        const dailyDays = Object.keys(dayMap).sort();
        const dailyAvgs = dailyDays.map(d => +mean(dayMap[d]).toFixed(4));

        /* ---- feature bucket charts ---- */
        const featureCharts = [];
        const tradesWithFeatures = this.trades.filter(t => t.features && Array.isArray(t.features));
        for (let i = 0; i < this.featuresDef.length; i++) {
            const def = this.featuresDef[i];
            const bucketMap = {};
            for (const t of tradesWithFeatures) {
                if (t.features.length <= i) continue;
                const bucket = Math.round(t.features[i] / def.bucketSize) * def.bucketSize;
                if (!bucketMap[bucket]) bucketMap[bucket] = [];
                bucketMap[bucket].push(t.profitPercent * 100);
            }
            const buckets = Object.keys(bucketMap).map(Number).sort((a, b) => a - b);
            const corr = m.featureCorrelations && m.featureCorrelations[i];
            featureCharts.push({
                name: def.name,
                labels: buckets.map(b => b.toLocaleString('en-US')),
                data: buckets.map(b => +mean(bucketMap[b]).toFixed(4)),
                counts: buckets.map(b => bucketMap[b].length),
                correlation: corr,
            });
        }

        /* ---- holdings still open ---- */
        const holdingNames = Object.keys(this.stockBalances);
        const holdingsHtml = holdingNames.length > 0
            ? '<details id="sec-holdings" style="margin-top:2rem"><summary style="cursor:pointer;font-size:1.1rem;font-weight:600">Stocks Still in Portfolio (' + holdingNames.length + ')</summary><table>' +
              '<thead><tr><th>Stock</th><th>Qty</th><th>Value</th><th>Held since</th></tr></thead><tbody>' +
              holdingNames.map(s => {
                  const qty = this.stockBalances[s];
                  const val = Math.round(this.stockPrices[s] * qty);
                  const since = this.holdSince[s] ? formatDate(this.holdSince[s]) : '-';
                  return `<tr><td style="text-align:left">${s}</td><td>${qty.toLocaleString('en-US')}</td><td>$${val.toLocaleString('en-US')}</td><td>${since}</td></tr>`;
              }).join('') +
              '</tbody></table></details>'
            : '';

        /* ---- feature chart HTML + JS ---- */
        const featureSectionsHtml = featureCharts.map((fc, idx) => {
            const corrStr = fc.correlation == null ? 'n/a' : fc.correlation.toFixed(3);
            const corrColor = fc.correlation == null ? '#888'
                : Math.abs(fc.correlation) > 0.3 ? '#00ffff'
                : Math.abs(fc.correlation) > 0.15 ? '#ffff44' : '#888';
            return `<section id="sec-feat-${idx}">` +
                `<h2>${fc.name}</h2>` +
                `<p style="margin:0 0 0.5rem;font-size:0.9rem;color:#aaa">Correlation with profit: <span style="color:${corrColor};font-weight:600">${corrStr}</span></p>` +
                `<div class="cw"><canvas id="fc${idx}"></canvas></div>` +
                `</section>`;
        }).join('\n');

        const featureSectionsJs = featureCharts.map((fc, idx) =>
            `new Chart(document.getElementById('fc${idx}'),{type:'bar',data:{labels:${JSON.stringify(fc.labels)},datasets:[{label:'Avg profit %',data:${JSON.stringify(fc.data)},backgroundColor:'rgba(255,246,124,0.7)',borderColor:'rgba(255,246,124,1)',borderWidth:1,yAxisID:'y'},{label:'Count',data:${JSON.stringify(fc.counts)},type:'line',borderColor:'rgba(100,200,150,1)',backgroundColor:'rgba(100,200,150,0.15)',borderWidth:2,pointRadius:2,fill:false,yAxisID:'y1'}]},options:{interaction:{mode:'index',intersect:false},responsive:true,maintainAspectRatio:false,scales:{y:{title:{display:true,text:'%'},grid:{color:'#2a2a2e'},position:'left'},y1:{title:{display:true,text:'Count'},grid:{drawOnChartArea:false},position:'right'},x:{grid:{color:'#2a2a2e'},ticks:{maxRotation:45,maxTicksLimit:30}}},plugins:{tooltip:{mode:'index',intersect:false},legend:{position:'top'}}}});`
        ).join('\n');

        const dailyColors = dailyAvgs.map(v => v >= 0 ? 'rgba(68,255,68,0.7)' : 'rgba(255,68,68,0.7)');

        /* ---- swaps table ---- */
        const fmtD = ts => formatDate(new Date(ts));
        const fmtUSD = v => '$' + Math.round(v).toLocaleString('en-US');
        const swapsHtml = this.swaps.length > 0
            ? `<details id="sec-swaps" style="margin-top:2rem"><summary style="cursor:pointer;font-size:1.1rem;font-weight:600">Swaps (${this.swaps.length})</summary>` +
              `<table class="log-table"><thead><tr><th>Date</th><th>Stock</th><th>Side</th><th>Qty</th><th>Price</th><th>Total</th><th>Fee</th></tr></thead><tbody>` +
              this.swaps.map(s => {
                  const side = s.type === 'buy' ? 'BUY' : 'SELL';
                  const sideColor = s.type === 'buy' ? '#44ff44' : '#ff4444';
                  return `<tr><td class="mono">${fmtD(s.timestamp)}</td><td class="bold">${s.stockName}</td><td style="color:${sideColor};font-weight:700">${side}</td><td>${s.quantity.toLocaleString('en-US')}</td><td>$${s.price.toLocaleString('en-US')}</td><td>${fmtUSD(s.quantity * s.price)}</td><td>${fmtUSD(s.fee)}</td></tr>`;
              }).join('') +
              '</tbody></table></details>'
            : '';

        /* ---- trades table ---- */
        const tradesHtml = this.trades.length > 0
            ? `<details id="sec-trades" style="margin-top:2rem"><summary style="cursor:pointer;font-size:1.1rem;font-weight:600">Trades (${this.trades.length})</summary>` +
              `<table class="log-table"><thead><tr><th>Date</th><th>Stock</th><th>Profit $</th><th>Profit %</th><th>Qty</th><th>Price</th><th>Fee</th>` +
              (this.featuresDef.length > 0 ? '<th>Features</th>' : '') +
              `</tr></thead><tbody>` +
              this.trades.map(t => {
                  const pColor = t.profit >= 0 ? '#44ff44' : '#ff4444';
                  const pSign = t.profit >= 0 ? '+' : '-';
                  const featCells = this.featuresDef.length > 0
                      ? '<td class="mono" style="color:#00ffff;font-size:0.8rem">' +
                        (t.features ? t.features.map((f, i) => {
                            const name = this.featuresDef[i]?.name ?? ('f' + i);
                            const v = typeof f === 'number' ? f.toFixed(4) : f;
                            return `${name}:${v}`;
                        }).join(' ') : '-') + '</td>'
                      : '';
                  return `<tr><td class="mono">${fmtD(t.timestamp)}</td><td class="bold">${t.stockName}</td><td style="color:${pColor};font-weight:700">${pSign}$${Math.abs(+t.profit.toFixed(2)).toLocaleString('en-US')}</td><td style="color:${pColor}">${(t.profitPercent * 100).toFixed(1)}%</td><td>${t.quantity.toLocaleString('en-US')}</td><td>$${t.price.toLocaleString('en-US')}</td><td>${fmtUSD(t.fee)}</td>${featCells}</tr>`;
              }).join('') +
              '</tbody></table></details>'
            : '';

        /* ---- nav with sections ---- */
        const navSections = [
            { title: 'Overview', links: [{ href: '#sec-summary', label: 'Summary' }] },
            {
                title: 'Charts',
                links: [
                    { href: '#sec-equity', label: 'Equity' },
                    { href: '#sec-daily', label: 'Daily P/L' },
                ],
            },
            {
                title: 'Features',
                links: featureCharts.map((fc, idx) => ({ href: `#sec-feat-${idx}`, label: fc.name })),
            },
            {
                title: 'Data',
                links: [
                    ...(holdingNames.length > 0 ? [{ href: '#sec-holdings', label: 'Holdings' }] : []),
                    ...(this.trades.length > 0 ? [{ href: '#sec-trades', label: 'Trades' }] : []),
                    ...(this.swaps.length > 0 ? [{ href: '#sec-swaps', label: 'Swaps' }] : []),
                ],
            },
        ].filter(s => s.links.length > 0);
        const navHtml = navSections.filter(s => s.links.length > 0).map(s =>
            `<div class="nav-section"><div class="nav-section-title">${s.title}</div>` +
            s.links.map(l => `<a href="${l.href}">${l.label}</a>`).join('') +
            '</div>'
        ).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Backtest Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;margin:0;background:#0f0f12;color:#e0e0e0}
.sidebar{position:fixed;top:0;left:0;width:180px;height:100vh;background:#141418;border-right:1px solid #2a2a2e;padding:1rem 0.75rem;display:flex;flex-direction:column;gap:0.25rem;z-index:10}
.sidebar .nav-section{margin-bottom:0.75rem}
.sidebar .nav-section-title{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#666;padding:0.25rem 0.6rem;margin-bottom:0.2rem}
.sidebar a{display:block;padding:0.4rem 0.6rem;border-radius:6px;color:#aaa;text-decoration:none;font-size:0.85rem;transition:background 0.15s,color 0.15s}
.sidebar a:hover{background:#1f1f26;color:#fff}
.main{margin-left:180px;padding:1.5rem 2rem}
h1{font-size:1.5rem;margin-bottom:0.25rem}
h2{font-size:1.1rem;margin:2rem 0 0.5rem}
.rank-badge{display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;border-radius:14px;font-size:2.8rem;font-weight:900;letter-spacing:-2px;border:3px solid;margin:1rem 0 1.5rem;position:relative;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{filter:brightness(1) drop-shadow(0 0 6px var(--glow))}50%{filter:brightness(1.2) drop-shadow(0 0 18px var(--glow))}}
.metrics{border-collapse:collapse;margin-bottom:0.5rem;font-size:0.95rem}
.metrics td{padding:0.3rem 1rem 0.3rem 0;border:none;white-space:nowrap}
.metrics td:first-child{color:#888;padding-right:2rem}
.cw{max-width:1200px;height:400px;margin-bottom:1rem}
table{border-collapse:collapse;margin-top:1rem;font-size:0.85rem}
th,td{border:1px solid #333;padding:0.3rem 0.6rem;text-align:right}
th{background:#1a1a1f}
tr:nth-child(even){background:#16161a}
section{scroll-margin-top:1rem}
.log-table{width:100%;font-size:0.8rem;font-family:'SF Mono',Menlo,Consolas,monospace}
.log-table th{text-align:left;padding:0.35rem 0.6rem;font-weight:600;color:#888;border-bottom:2px solid #333}
.log-table td{padding:0.25rem 0.6rem;border:none;border-bottom:1px solid #1e1e24;white-space:nowrap}
.log-table tr:hover{background:#1a1a22}
.log-table .mono{font-family:'SF Mono',Menlo,Consolas,monospace;color:#888}
.log-table .bold{font-weight:700}
</style>
</head>
<body>
<nav class="sidebar">
${navHtml}
</nav>
<div class="main">
<section id="sec-summary">
<h1>Backtest Report</h1>
<table class="metrics">
<tr><td>Period</td><td>${this.startDate.toISOString().slice(0, 10)} → ${this.endDate.toISOString().slice(0, 10)}</td></tr>
<tr><td>Trades</td><td>${this.trades.length} (win-rate ${winRate}%) / ${this.swaps.length} swaps</td></tr>
<tr><td>Fees</td><td>$${Math.round(this.totalFees).toLocaleString('en-US')}</td></tr>
<tr><td>Total USD return</td><td style="color:${retColor(m.totalReturn)}">${m.totalReturn >= 0 ? '+' : '-'}$${Math.abs(Math.round(m.totalReturn * this.capital)).toLocaleString('en-US')} ($${this.capital.toLocaleString('en-US')} → $${finalEquity.toLocaleString('en-US')})</td></tr>
<tr><td>Total % return</td><td style="color:${retColor(m.totalReturn)}">${m.totalReturn >= 0 ? '+' : ''}${(m.totalReturn * 100).toFixed(2)}%</td></tr>
<tr><td>Avg daily return</td><td style="color:${retColor(m.avgDaily)}">${m.avgDaily >= 0 ? '+' : ''}${(m.avgDaily * 100).toFixed(3)}% (geo ${(m.geoDaily * 100).toFixed(3)}%, ${(m.dailyWinRate * 100).toFixed(1)}% of ${m.days} days up)</td></tr>
<tr><td>CAGR (Annualized)</td><td style="color:${retColor(m.CAGR)}">${m.CAGR >= 0 ? '+' : ''}${(m.CAGR * 100).toFixed(1)}%</td></tr>
<tr><td>Geo-mean ${this.strategy.mainInterval.name}</td><td style="color:${retColor(m.geoPeriodRet)}">${m.geoPeriodRet >= 0 ? '+' : ''}${(m.geoPeriodRet * 100).toFixed(4)}% (annual ≈ ${(m.geoAnnualRet * 100).toFixed(1)}%)</td></tr>
<tr><td>Geo-mean annual</td><td style="color:${retColor(m.geoAnnualRet)}">${m.geoAnnualRet >= 0 ? '+' : ''}${(m.geoAnnualRet * 100).toFixed(2)}%</td></tr>
<tr><td>Max drawdown</td><td style="color:${maxDDColor}">${(m.maxDrawdown * 100).toFixed(1)}%</td></tr>
<tr><td>Sharpe</td><td style="color:${sharpeColor}">${m.sharpe.toFixed(2)}</td></tr>
</table>
<div class="rank-container">
<span class="rank-label" style="font-size: 28px;margin-right: 300px;">Rank:</span>
<div class="rank-badge" style="color:${rankColor};border-color:${rankColor};--glow:${rankGlow}">${rank}</div>
</div>
${this.totalFees === 0 && (rank === 'B' || rank === 'A' || rank === 'S') ? '<div style="opacity: 0.5; font-style: italic; font-size: 12px;">Good job, now do it with fees on.</div>' : ''}
</section>
<section id="sec-equity">
<h2>Equity &amp; Cash Over Time</h2>
<div class="cw"><canvas id="eqChart"></canvas></div>
</section>
<section id="sec-daily">
<h2>Average Profit % Per Day</h2>
<div class="cw"><canvas id="dpChart"></canvas></div>
</section>
${featureSectionsHtml}
${holdingsHtml}
${tradesHtml}
${swapsHtml}
</div>
<script>
new Chart(document.getElementById('eqChart'),{type:'line',data:{labels:${JSON.stringify(equityLabels)},datasets:[{label:'Equity ($)',data:${JSON.stringify(equityValues)},borderColor:'#44ff44',backgroundColor:'rgba(68,255,68,0.08)',borderWidth:1.5,pointRadius:0,fill:true},{hidden: true,label:'Cash ($)',data:${JSON.stringify(cashValues)},borderColor:'#ff9f1a',backgroundColor:'rgba(255,159,26,0.06)',borderWidth:1.5,pointRadius:0,fill:true}]},options:{interaction:{mode:'index',intersect:false},responsive:true,maintainAspectRatio:false,scales:{y:{title:{display:true,text:'$'},grid:{color:'#2a2a2e'}},x:{grid:{color:'#2a2a2e'},ticks:{maxRotation:45,maxTicksLimit:20}}},plugins:{tooltip:{mode:'index',intersect:false},legend:{position:'top'}}}});
new Chart(document.getElementById('dpChart'),{type:'bar',data:{labels:${JSON.stringify(dailyDays)},datasets:[{label:'Avg profit %',data:${JSON.stringify(dailyAvgs)},backgroundColor:${JSON.stringify(dailyColors)},borderWidth:0}]},options:{interaction:{mode:'index',intersect:false},responsive:true,maintainAspectRatio:false,scales:{y:{title:{display:true,text:'%'},grid:{color:'#2a2a2e'}},x:{grid:{color:'#2a2a2e'},ticks:{maxTicksLimit:20,maxRotation:45}}},plugins:{tooltip:{mode:'index',intersect:false},legend:{position:'top'}}}});
${featureSectionsJs}
</script>
</body>
</html>`;
    }
}
