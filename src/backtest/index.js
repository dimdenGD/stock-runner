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
    constructor({ strategy, startDate, endDate, startCashBalance, broker = new Broker(), logs = {} }) {
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
        
        this.broker = broker;
        this.totalFees = 0;
        this.buffers = {};

        this.logs = logs;
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

            // invoke strategy
            await this.strategy.onTick({
                stockName,
                candle: mainCandle,
                ctx: this,
                stockBalance: this.stockBalances[stockName] || 0,
                getCandles: (intervalName, count, ts = mainCandle.timestamp) => getCandles(ts, intervalName, count),
                buy: (quantity, price) => this.buy(stockName, quantity, price, mainCandle.timestamp),
                sell: (quantity, price) => this.sell(stockName, quantity, price, mainCandle.timestamp),
            });

            this.equityCurve.push([mainCandle.timestamp, this.totalValue()]);
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

                    arr.push({
                        stockName,
                        candle,
                        stockBalance: this.stockBalances[stockName] || 0,
                        getCandles: (intervalName, count, ts = currentDate) => getCandles(ts, stock, intervalName, count),
                        buy: (quantity, price) => this.buy(stockName, quantity, price, currentDate),
                        sell: (quantity, price) => this.sell(stockName, quantity, price, currentDate),
                    })
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
                    this.equityCurve.push([currentDate, this.totalValue()]);
                }
            }
        }

        console.log('Backtest finished in', ms(Date.now() - start));
        return this.getMetrics();
    }

    totalValue() {

        return this.cashBalance + Object.entries(this.stockBalances).reduce((acc, [stockName, quantity]) => acc + quantity * this.stockPrices[stockName], 0);
    }

    buy(stockName, quantity, price, timestamp) {
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
        if(this.logs.trades) {
            const swaps = this.swaps.toReversed().filter(t => t.stockName === stockName);
            const lastSell = swaps.findIndex(t => t.type === 'sell');
            const buys = swaps.slice(0, lastSell === -1 ? swaps.length : lastSell).filter(t => t.type === 'buy');
            const cost = buys.reduce((acc, t) => acc + t.quantity * t.price, 0);
            const fee = buys.reduce((acc, t) => acc + t.fee, 0);
            const profit = proceeds - cost - fee;
            const profitPercent = profit / cost;
            const holdTime = ms(timestamp - this.holdSince[stockName]);

            console.log(
                chalk.gray(`${formatDate(new Date(timestamp))} `) +
                chalk.bold(`${stockName.padEnd(7)} `) +
                chalk[profit > 0 ? 'green' : 'red'](
                    `${profit > 0 ? '+$' : '-$'}${(+Math.abs(profit).toFixed(2)).toLocaleString('en-US').padEnd(10)} ` +
                    `(${(profitPercent * 100).toFixed(1)}%)`.padEnd(12)
                ) +
                chalk.white(`${holdTime}`.padEnd(5)) +
                chalk.gray(`CASH $${Math.round(this.cashBalance).toLocaleString('en-US')} | EQUITY $${Math.round(this.totalValue()).toLocaleString('en-US')}`)
            );
            this.trades.push({ stockName, quantity, price, timestamp, fee, profit, profitPercent });
        }

        if(this.stockBalances[stockName] === 0) {
            delete this.stockBalances[stockName];
            delete this.holdSince[stockName];
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
}
