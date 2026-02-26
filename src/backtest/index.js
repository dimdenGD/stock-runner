import { formatDate, splitArray } from '../utils.js';
import Broker from '../brokers/base.js';
import CandleBuffer from './candleBuffer.js';
import Strategy from './strategy.js';
import { loadStockBeforeTimestamp, loadAllStocksInRange } from './loader.js';
import { intervalMsMap } from './consts.js';
import chalk from 'chalk';
import { eachDayOfInterval, eachMinuteOfInterval, eachHourOfInterval, subDays, addDays, addMinutes } from 'date-fns';
import ms from 'ms';

const sharpePeriods = {
    '1d': 252,
    '1h': 252 * 6.5,   // 6.5 trading hours per day
    '5m': 252 * 78,    // 78 five-min bars per 6.5h day
    '1m': 252 * 390,   // 390 minutes in a trading day
}

const oneStockPreloadAmounts = {
    '1d': 600,
    '1h': 2000,
    '5m': 5000,
    '1m': 10000,
}

const allStocksPreloadAmounts = {
    '1d': 250,
    '1h': 500,
    '5m': 1000,
    '1m': 2000,
}

const preloadWindowMs = {
    '1d': 1000 * 60 * 60 * 24 * 365,   // 1 year
    '1h': 1000 * 60 * 60 * 24 * 31 * 4,    // 4 months
    '5m': 1000 * 60 * 60 * 24 * 7 * 4,    // 4 weeks
    '1m': 1000 * 60 * 60 * 24 * 14,    // 2 weeks
}

/** Returns dates at step-minute intervals in [start, end]. */
function eachStepMinuteOfInterval({ start, end }, stepMinutes) {
    const dates = [];
    let d = new Date(start);
    while (d <= end) {
        dates.push(d);
        d = addMinutes(d, stepMinutes);
    }
    return dates;
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

const setHoursDifferentTZ = (inputDateTime, timeZone, setHoursArray) => {
    inputDateTime.setHours(setHoursArray[0],setHoursArray[1]);

    const dateTZShifted = inputDateTime.toLocaleString("en-US", {timeZone : timeZone , dateStyle: 'long', timeStyle: 'long'});
    let timeTZShifted = dateTZShifted.split(" ").slice(4,5).join(' ').toString().split(':');
    let originalTime = inputDateTime.toString().split(" ").slice(4,5).join(' ').toString().split(':');
    let newLocalTime = [
        Number(originalTime[0]) - Number(timeTZShifted[0]) + Number(originalTime[0]),
        Number(originalTime[1]) - Number(timeTZShifted[1]) + Number(originalTime[1]), 
        Number(originalTime[2]) - Number(timeTZShifted[2]) + Number(originalTime[2])
    ];
    let outputDate = new Date(inputDateTime);
    outputDate.setHours(Number(newLocalTime[0]), Number(newLocalTime[1]),Number(newLocalTime[2]));

    return outputDate;   
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
     * @param {number} params.startCashBalance    – Starting cash balance
     */
    constructor({ strategy, startDate, endDate, startCashBalance, broker = new Broker(), logs = {}, features = [] }) {
        if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
            throw new TypeError('startDate and endDate must be instances of Date');
        }
        if (typeof startCashBalance !== 'number') {
            throw new TypeError('startCashBalance must be a number');
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

        this.startCashBalance = startCashBalance;
        this.cashBalance = startCashBalance;
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
    }

    async runOnStock(stockName) {
        if(!this.buffers[stockName]) {
            this.buffers[stockName] = {};
        }
        const buffers = this.buffers[stockName];
        // initialize buffers
        for(let iv in this.strategy.intervals) {
            const interval = this.strategy.intervals[iv];
            if(interval.preload) {
                buffers[interval.name] = new CandleBuffer(stockName, interval.name, this.startDate, this.endDate, interval.count, oneStockPreloadAmounts[interval.name]);
            }
        }
        // preload initial chunks
        await Promise.all(
            Object.values(buffers).map(buf => buf.ensure(this.startDate))
        );
        const mainBuf = buffers[this.strategy.mainInterval.name].buffer;
        const lookback = this.strategy.mainInterval.count;
        const getCandles = (ts, intervalName, count) => {
            const interval = this.strategy.intervals[intervalName];
            if(!interval) {
                throw new Error(`Interval ${intervalName} not found. You need to request it in the strategy constructor.`);
            }
            if(!interval.preload) {
                return new Promise(async (resolve, reject) => {
                    try {
                        const stock = await loadStockBeforeTimestamp(stockName, interval.name, new Date(ts), count*2);
                        if(stock.size < count) {
                            return resolve(null);
                        }
                        resolve([...stock].slice(0, count));
                    } catch(e) {
                        reject(e);
                    }
                });
            }
            const candles = buffers[intervalName].getLast(count, ts);
            if(candles.length < count) {
                return resolve(null);
            }
            return resolve(candles.reverse().slice(0, count));
        };

        // iterate once we have full lookback
        for (let i = lookback - 1; i < mainBuf.length; i++) {
            const mainCandle = mainBuf[i];
            const ts = mainCandle.timestamp;
            if (ts >= this.endDate) break;

            // top up all buffers as we advance
            await Promise.all(
                Object.values(buffers).map(buf => buf.ensure(ts))
            );

            this.stockPrices[stockName] = mainCandle.close;

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
                buy: (quantity, price) => this.buy(stockName, quantity, price, mainCandle.timestamp, tickObj._features),
                sell: (quantity, price) => this.sell(stockName, quantity, price, mainCandle.timestamp),
            };
            await this.strategy.onTick(tickObj);

            this.equityCurve.push([mainCandle.timestamp, this.totalValue(), this.cashBalance]);
        }

        return this.getMetrics();
    }

    async runOnAllStocks() {
        const interval = this.strategy.mainInterval.name;
        const intervalFns = {
            '1d': eachDayOfInterval,
            '1h': eachHourOfInterval,
            '5m': (opts) => eachStepMinuteOfInterval(opts, 5),
            '1m': eachMinuteOfInterval,
        };
        const intervalFn = intervalFns[interval] ?? eachMinuteOfInterval;
        const dates = intervalFn({ start: this.startDate, end: this.endDate });
        const chunks = splitArray(dates, allStocksPreloadAmounts[interval]);
        const start = Date.now();

        if(interval === '1d') {
            for(const date of dates) {
                // set to 4 PM EST (closing time)
                const nyDate = setHoursDifferentTZ(date, 'America/New_York', [16, 0, 0]);
                date.setTime(nyDate.getTime());
            }
        }

        const dbFallback = (stockName, intervalName, ts, count) => {
            return loadStockBeforeTimestamp(stockName, intervalName, new Date(ts), count * 2)
                .then(loaded => {
                    if(loaded.size < count) return null;
                    return [...loaded].slice(0, count);
                });
        };

        const preloadedIntervals = {};
        for (const ivName in this.strategy.intervals) {
            const iv = this.strategy.intervals[ivName];
            if (iv.preload && ivName !== interval) {
                preloadedIntervals[ivName] = iv;
            }
        }

        const preloadedStocks = {};
        const preloadWindowEnd = {};

        const ensurePreloaded = async (currentDate) => {
            const ts = currentDate.getTime();
            for (const ivName in preloadedIntervals) {
                if (!preloadWindowEnd[ivName] || ts >= preloadWindowEnd[ivName]) {
                    const iv = preloadedIntervals[ivName];
                    const lookbackMs = iv.count * intervalMsMap[ivName] * 3;
                    const windowMs = preloadWindowMs[ivName];
                    const startDate = new Date(ts - lookbackMs);
                    const endDate = new Date(ts + windowMs);
                    preloadedStocks[ivName] = await loadAllStocksInRange(ivName, startDate, endDate);
                    preloadWindowEnd[ivName] = endDate.getTime();
                }
            }
        };

        const getCandles = (ts, stock, intervalName, count) => {
            const iv = this.strategy.intervals[intervalName];
            if(!iv) {
                throw new Error(`Interval ${intervalName} not found. You need to request it in the strategy constructor.`);
            }
            if(!iv.preload) {
                return dbFallback(stock.name, iv.name, ts, count);
            }

            const targetStock = (intervalName === this.strategy.mainInterval.name)
                ? stock
                : preloadedStocks[intervalName]?.[stock.name];

            if(!targetStock) {
                return dbFallback(stock.name, intervalName, ts, count);
            }

            let index = targetStock.getIndex(ts);
            if (index >= targetStock.size) {
                return dbFallback(stock.name, intervalName, ts, count);
            }
            const barAtIndex = targetStock.getCandle(index);
            if (barAtIndex && barAtIndex.timestamp > ts) {
                index--;
            }
            if (index < 0) {
                return dbFallback(stock.name, intervalName, ts, count);
            }
            const start = index - count + 1;
            if (start < 0) {
                return dbFallback(stock.name, intervalName, ts, count);
            }
            const arr = [];
            for (let i = start; i <= index; i++) {
                const candle = targetStock.getCandle(i);
                if (candle) arr.push(candle);
            }
            if (arr.length < count) {
                return dbFallback(stock.name, intervalName, ts, count);
            }
            return arr.reverse().slice(0, count);
        }

        let min = this.strategy.mainInterval.count;
        for(let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`++++++++++++++++++++ ${((i / chunks.length) * 100).toFixed(2)}%`);
            const stocks = await loadAllStocksInRange(interval, subDays(chunk[0], min*2), addDays(chunk[chunk.length - 1], 4));
            for(const currentDate of chunk) {
                await ensurePreloaded(currentDate);
                const day = currentDate.toLocaleDateString('en-US', { weekday: 'short', timeZone: "UTC" });
                if(day === 'Sat' || day === 'Sun') {
                    continue;
                }
                if(currentDate < chunk[0]) {
                    continue;
                }
                const arr = [];

                for(const stockName in stocks) {
                    const stock = stocks[stockName];
                    const candle = stock.getCandle(stock.getIndex(currentDate));
                    if(!candle) continue;

                    this.stockPrices[stockName] = candle.close;

                    const item = {
                        stockName,
                        candle,
                        stockBalance: this.stockBalances[stockName] || 0,
                        _features: null,
                        features: this.stockFeatures[stockName] ?? null,
                        setFeatures(features) { this._features = features; },
                        getCandles: (intervalName, count, ts = currentDate) => {
                            if(ts.getTime() > currentDate.getTime()) {
                                throw new Error(`Requested candles in the future: ${ts.toISOString()} > ${currentDate.toISOString()}`);
                            }
                            return getCandles(ts, stock, intervalName, count);
                        },
                        buy: (quantity, price) => this.buy(stockName, quantity, price, currentDate, item._features),
                        sell: (quantity, price) => this.sell(stockName, quantity, price, currentDate),
                    };
                    arr.push(item);
                }

                if(arr.length > 0) {
                    // delisted stocks
                    if(Object.keys(this.stockBalances).length > 0) {
                        for(const stockName in this.stockBalances) {
                            if(!arr.find(s => s.stockName === stockName)) {
                                this.delistCounter[stockName] = (this.delistCounter[stockName] || 0) + 1;
                                if(this.delistCounter[stockName] > 10) {
                                    delete this.stockBalances[stockName];
                                    console.log(chalk.red(`${stockName} DELISTED ON ${formatDate(subDays(currentDate, interval === '1d' ? 10 : 0))}`));
                                }
                            }
                        }
                    }

                    await this.strategy.onTick({
                        raw: stocks,
                        currentDate,
                        ctx: this,
                        stocks: arr
                    });
                    this.equityCurve.push([currentDate, this.totalValue(), this.cashBalance]);
                }
            }
        }

        console.log('Backtest finished in', ms(Date.now() - start));
        return this.getMetrics();
    }

    totalValue() {

        return this.cashBalance + Object.entries(this.stockBalances).reduce((acc, [stockName, quantity]) => acc + quantity * this.stockPrices[stockName], 0);
    }

    buy(stockName, quantity, price, timestamp, features) {
        const cost = quantity * price;
        const fee = this.broker.calculateFees(quantity, price, 'buy');
        if (cost + fee > this.cashBalance) {
            throw new Error(`Insufficient cash: need ${cost + fee}, have ${this.cashBalance}`);
        }
        this.cashBalance -= (cost + fee);
        this.stockBalances[stockName] = (this.stockBalances[stockName] || 0) + quantity;
        this.totalFees += fee;
        this.swaps.push({ type: 'buy', quantity, price, timestamp, fee, stockName });
        this.stockPrices[stockName] = price;
        this.holdSince[stockName] = timestamp;
        if (features != null && Array.isArray(features)) {
            this.stockFeatures[stockName] = features;
        }

        if(this.logs.swaps) {
            const equity = this.totalValue();
            console.log(
                chalk.gray(`${formatDate(new Date(timestamp))} `) +
                chalk.bold(`${stockName.padEnd(7)} `) +
                chalk.greenBright(`BUY  `) +
                chalk.white(`${quantity.toLocaleString('en-US')} `.padEnd(8)) +
                chalk.white(`@ $${price.toLocaleString('en-US')} `.padEnd(10)) +
                chalk.gray(` | `) +
                chalk.white(`$${Math.round(price * quantity).toLocaleString('en-US')}`.padEnd(11)) +
                chalk.white(` + $${Math.round(fee).toLocaleString('en-US')} fee`.padEnd(16)) +
                chalk.gray(`CASH $${Math.round(this.cashBalance).toLocaleString('en-US')} | EQUITY $${Math.round(equity).toLocaleString('en-US')}`.padEnd(10))
            );
        }
    }

    sell(stockName, quantity, price, timestamp) {
        if(!this.stockBalances[stockName]) {
            throw new Error(`Insufficient shares: have 0, trying to sell ${quantity}`);
        }
        if (quantity > this.stockBalances[stockName]) {
            throw new Error(`Insufficient shares: have ${this.stockBalances[stockName]}, trying to sell ${quantity}`);
        }
        const proceeds = quantity * price;
        const fee = this.broker.calculateFees(quantity, price, 'sell');
        this.cashBalance += (proceeds - fee);
        this.stockBalances[stockName] -= quantity;
        this.totalFees += fee;
        this.stockPrices[stockName] = price;

        if(this.logs.swaps) {
            const equity = this.totalValue();
            console.log(
                chalk.gray(`${formatDate(new Date(timestamp))} `) +
                chalk.bold(`${stockName.padEnd(7)} `) +
                chalk.redBright(`SELL `) +
                chalk.white(`${quantity.toLocaleString('en-US')} `.padEnd(8)) +
                chalk.white(`@ $${price.toLocaleString('en-US')} `.padEnd(10)) +
                chalk.gray(` | `) +
                chalk.white(`$${Math.round(price * quantity).toLocaleString('en-US')}`.padEnd(11)) +
                chalk.white(` + $${Math.round(fee).toLocaleString('en-US')} fee`.padEnd(16)) +
                chalk.gray(`CASH $${Math.round(this.cashBalance).toLocaleString('en-US')} | EQUITY $${Math.round(equity).toLocaleString('en-US')}`.padEnd(10))
            );
        }
        const swaps = this.swaps.toReversed().filter(t => t.stockName === stockName);
        const lastSell = swaps.findIndex(t => t.type === 'sell');
        const buys = swaps.slice(0, lastSell === -1 ? swaps.length : lastSell).filter(t => t.type === 'buy');
        const cost = buys.reduce((acc, t) => acc + t.quantity * t.price, 0);
        const buyFees = buys.reduce((acc, t) => acc + t.fee, 0);
        const profit = proceeds - cost - buyFees - fee;
        const profitPercent = cost ? profit / cost : 0;
        const features = this.stockFeatures[stockName];
        this.trades.push({ stockName, quantity, price, timestamp, fee, profit, profitPercent, features: features ?? undefined });

        if(this.logs.trades) {
            const holdTime = ms(timestamp - this.holdSince[stockName]);
            let line = chalk.gray(`${formatDate(new Date(timestamp))} `) +
                chalk.bold(`${stockName.padEnd(7)} `) +
                chalk[profit > 0 ? 'green' : 'red'](
                    `${profit > 0 ? '+$' : '-$'}${(+Math.abs(profit).toFixed(2)).toLocaleString('en-US').padEnd(10)} ` +
                    `(${(profitPercent * 100).toFixed(1)}%)`.padEnd(12)
                ) +
                chalk.white(`${holdTime}`.padEnd(5)) +
                chalk.gray(`CASH $${Math.round(this.cashBalance).toLocaleString('en-US')} | EQUITY $${Math.round(this.totalValue()).toLocaleString('en-US')}`);
            if (features != null && features.length > 0) {
                line += chalk.cyan(` [${features.map(f => typeof f === 'number' ? f.toFixed(4) : f).join(', ')}]`);
            }
            console.log(line);
        }

        if(this.stockBalances[stockName] === 0) {
            delete this.stockBalances[stockName];
            delete this.holdSince[stockName];
            delete this.stockFeatures[stockName];
        }

        this.swaps.push({ type: 'sell', quantity, price, timestamp, fee, stockName });
    }

    getMetrics() {
        if (this.equityCurve.length < 2) {
            throw new Error('Backtest not run or equityCurve too short');
        }

        /* ---------- equity series & simple returns ---------------------- */
        const series = this.equityCurve
            .toSorted((a, b) => a[0] - b[0])       // sort by timestamp
            .map(e => e[1]);                       // strip to equity values

        const periodRets = [];
        for (let i = 1; i < series.length; i++) {
            periodRets.push(series[i] / series[i - 1] - 1);
        }

        /* ---------- totals & CAGR -------------------------------------- */
        const finalEquity  = series.at(-1);
        const totalReturn  = finalEquity / this.startCashBalance - 1;
        const years        = (this.endDate - this.startDate) / (365 * 24 * 3600 * 1e3);
        const CAGR         = Math.pow(1 + totalReturn, 1 / years) - 1;

        /* ---------- Sharpe (annualised) -------------------------------- */
        const periodsPerYr = sharpePeriods[this.strategy.mainInterval.name] ?? 252;
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

        const avgDaily = periodRets.reduce((s, r) => s + r, 0) / periodRets.length;

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
            CAGR,
            sharpe,
            maxDrawdown   : maxDD,
            geoPeriodRet,
            geoAnnualRet,
            featureCorrelations,
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
        console.log(`Total USD return  : ${m.totalReturn > 0 ? chalk.greenBright('+$' + (Math.round(m.totalReturn * this.startCashBalance)).toLocaleString('en-US')) : chalk.redBright('-$' + Math.abs(Math.round(m.totalReturn * this.startCashBalance)).toLocaleString('en-US'))} ($${this.startCashBalance.toLocaleString('en-US')} → $${Math.round(this.totalValue()).toLocaleString('en-US')})`);
        console.log(`Total % return    : ${m.totalReturn > 0 ? chalk.greenBright('+' + (m.totalReturn * 100).toFixed(2) + '%') : chalk.redBright('' + (m.totalReturn * 100).toFixed(2) + '%')}`);
        console.log(`Avg daily return  : ${m.avgDaily > 0 ? chalk.greenBright('+' + (m.avgDaily * 100).toFixed(2) + '%') : chalk.redBright('' + (m.avgDaily * 100).toFixed(2) + '%')}`);
        console.log(`CAGR (Annualized) : ${m.CAGR > 0 ? chalk.greenBright('+' + (m.CAGR * 100).toFixed(1) + '%') : chalk.redBright('' + (m.CAGR * 100).toFixed(1) + '%')}`);
        console.log(`Geo-mean period   : ${m.geoPeriodRet > 0 ? chalk.greenBright('+' + (m.geoPeriodRet * 100).toFixed(2) + '%') : chalk.redBright('' + (m.geoPeriodRet * 100).toFixed(2) + '%')}  (annual ≈ ${(m.geoAnnualRet * 100).toFixed(1)}%)`);
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
        if(m.sharpe >= 3.5 && m.maxDrawdown >= -0.15 && m.avgDaily >= 0.008) {
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
        if (m.sharpe >= 3.5 && m.maxDrawdown >= -0.15 && m.avgDaily >= 0.008) {
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

        /* ---- nav links ---- */
        const navLinks = [
            { href: '#sec-summary', label: 'Summary' },
            { href: '#sec-equity', label: 'Equity' },
            { href: '#sec-daily', label: 'Daily P/L' },
            ...featureCharts.map((fc, i) => ({ href: `#sec-feat-${i}`, label: fc.name })),
            ...(holdingNames.length > 0 ? [{ href: '#sec-holdings', label: 'Holdings' }] : []),
        ];
        const navHtml = navLinks.map(l => `<a href="${l.href}">${l.label}</a>`).join('\n');

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
<tr><td>Total USD return</td><td style="color:${retColor(m.totalReturn)}">${m.totalReturn >= 0 ? '+' : '-'}$${Math.abs(Math.round(m.totalReturn * this.startCashBalance)).toLocaleString('en-US')} ($${this.startCashBalance.toLocaleString('en-US')} → $${finalEquity.toLocaleString('en-US')})</td></tr>
<tr><td>Total % return</td><td style="color:${retColor(m.totalReturn)}">${m.totalReturn >= 0 ? '+' : ''}${(m.totalReturn * 100).toFixed(2)}%</td></tr>
<tr><td>Avg daily return</td><td style="color:${retColor(m.avgDaily)}">${m.avgDaily >= 0 ? '+' : ''}${(m.avgDaily * 100).toFixed(4)}%</td></tr>
<tr><td>CAGR (Annualized)</td><td style="color:${retColor(m.CAGR)}">${m.CAGR >= 0 ? '+' : ''}${(m.CAGR * 100).toFixed(1)}%</td></tr>
<tr><td>Geo-mean period</td><td style="color:${retColor(m.geoPeriodRet)}">${m.geoPeriodRet >= 0 ? '+' : ''}${(m.geoPeriodRet * 100).toFixed(4)}% (annual ≈ ${(m.geoAnnualRet * 100).toFixed(1)}%)</td></tr>
<tr><td>Geo-mean annual</td><td style="color:${retColor(m.geoAnnualRet)}">${m.geoAnnualRet >= 0 ? '+' : ''}${(m.geoAnnualRet * 100).toFixed(2)}%</td></tr>
<tr><td>Max drawdown</td><td style="color:${maxDDColor}">${(m.maxDrawdown * 100).toFixed(1)}%</td></tr>
<tr><td>Sharpe</td><td style="color:${sharpeColor}">${m.sharpe.toFixed(2)}</td></tr>
</table>
<div class="rank-container">
<span class="rank-label" style="font-size: 28px;margin-right: 305px;">Rank:</span>
<div class="rank-badge" style="color:${rankColor};border-color:${rankColor};--glow:${rankGlow}">${rank}</div>
</div>
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
</div>
<script>
new Chart(document.getElementById('eqChart'),{type:'line',data:{labels:${JSON.stringify(equityLabels)},datasets:[{label:'Equity ($)',data:${JSON.stringify(equityValues)},borderColor:'#44ff44',backgroundColor:'rgba(68,255,68,0.08)',borderWidth:1.5,pointRadius:0,fill:true},{label:'Cash ($)',data:${JSON.stringify(cashValues)},borderColor:'#ff9f1a',backgroundColor:'rgba(255,159,26,0.06)',borderWidth:1.5,pointRadius:0,fill:true}]},options:{interaction:{mode:'index',intersect:false},responsive:true,maintainAspectRatio:false,scales:{y:{title:{display:true,text:'$'},grid:{color:'#2a2a2e'}},x:{grid:{color:'#2a2a2e'},ticks:{maxRotation:45,maxTicksLimit:20}}},plugins:{tooltip:{mode:'index',intersect:false},legend:{position:'top'}}}});
new Chart(document.getElementById('dpChart'),{type:'bar',data:{labels:${JSON.stringify(dailyDays)},datasets:[{label:'Avg profit %',data:${JSON.stringify(dailyAvgs)},backgroundColor:${JSON.stringify(dailyColors)},borderWidth:0}]},options:{interaction:{mode:'index',intersect:false},responsive:true,maintainAspectRatio:false,scales:{y:{title:{display:true,text:'%'},grid:{color:'#2a2a2e'}},x:{grid:{color:'#2a2a2e'},ticks:{maxTicksLimit:20,maxRotation:45}}},plugins:{tooltip:{mode:'index',intersect:false},legend:{position:'top'}}}});
${featureSectionsJs}
</script>
</body>
</html>`;
    }
}
