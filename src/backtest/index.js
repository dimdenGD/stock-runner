import { formatDate, splitArray } from '../utils.js';
import Broker from '../brokers/base.js';
import CandleBuffer from './candleBuffer.js';
import Strategy from './strategy.js';
import { loadStockBeforeTimestamp, loadAllStocksInRange } from './loader.js';
import chalk from 'chalk';
import { eachDayOfInterval, eachMinuteOfInterval } from 'date-fns';

const sharpePeriods = {
    '1d': 252,
    '1m': 252 * 390, // 390 minutes in a trading day
}

const oneStockPreloadAmounts = {
    '1d': 600,
    '1m': 10000,
}

const allStocksPreloadAmounts = {
    '1d': 250,
    '1m': 2000,
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
        this.stockPrices = {};

        this.swaps = [];
        this.trades = [];
        this.equityCurve = [];
        
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
                        resolve([...stock].reverse().slice(0, count));
                    } catch(e) {
                        reject(e);
                    }
                });
            }
            return buffers[intervalName].getLast(count, ts);
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
        const intervalFn = interval === '1d' ? eachDayOfInterval : eachMinuteOfInterval;
        const dates = intervalFn({ start: this.startDate, end: this.endDate });
        const chunks = splitArray(dates, allStocksPreloadAmounts[interval]);

        const getCandles = (ts, stock, intervalName, count) => {
            const interval = this.strategy.intervals[intervalName];
            if(!interval) {
                throw new Error(`Interval ${intervalName} not found. You need to request it in the strategy constructor.`);
            }
            if(!interval.preload) {
                return new Promise(async (resolve, reject) => {
                    try {
                        const stock = await loadStockBeforeTimestamp(stock.name, interval.name, new Date(ts), count*2);
                        resolve([...stock].reverse().slice(0, count));
                    } catch(e) {
                        reject(e);
                    }
                });
            }
            const index = stock.getIndex(ts);
            const arr = [];
            for(let i = index - count + 1; i <= index; i++) {
                const candle = stock.getCandle(i);
                if(!candle) continue;
                arr.push(candle);
            }
            if(arr.length < count) {
                return null;
            }
            return arr.reverse().slice(0, count);
        }

        let i = 0;
        let min = this.strategy.mainInterval.count;
        for(const chunk of chunks) {
            const stocks = await loadAllStocksInRange(interval, chunk[0], chunk[chunk.length - 1]);
            for(const currentDate of chunk) {
                if(i < min) {
                    i++;
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

                await this.strategy.onTick({
                    raw: stocks,
                    currentDate,
                    ctx: this,
                    stocks: arr
                });
                this.equityCurve.push([currentDate, this.totalValue()]);
                i++;
            }
        }

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
        if(this.stockBalances[stockName] === 0) {
            delete this.stockBalances[stockName];
        }
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

            console.log(
                chalk.gray(`${formatDate(new Date(timestamp))} `) +
                chalk.bold(`${stockName.padEnd(7)} `) +
                chalk[profit > 0 ? 'green' : 'red'](
                    `${profit > 0 ? '+$' : '-$'}${(+Math.abs(profit).toFixed(2)).toLocaleString('en-US').padEnd(10)} ` +
                    `(${(profitPercent * 100).toFixed(1)}%)`.padEnd(12)
                ) +
                chalk.gray(`CASH $${Math.round(this.cashBalance).toLocaleString('en-US')} | EQUITY $${Math.round(this.totalValue()).toLocaleString('en-US')}`)
            );
            this.trades.push({ stockName, quantity, price, timestamp, fee, profit, profitPercent });
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
        console.log('\n' + chalk.bold('=== BACKTEST SUMMARY ==='));
        console.log(`Period            : ${this.startDate.toISOString().slice(0,10)} → ${this.endDate.toISOString().slice(0,10)}`);
        console.log(`Trades            : ${this.trades.length}  (win-rate ${(this.trades.filter(t => t.profit > 0).length / this.trades.length * 100).toFixed(2)}%) / ${this.swaps.length} swaps`);
        console.log(`Fees              : $${this.totalFees.toLocaleString('en-US')}`);
        console.log(`Total USD return  : ${m.totalReturn > 0 ? chalk.greenBright('+$' + (m.totalReturn * this.startCashBalance).toLocaleString('en-US')) : chalk.redBright('-$' + Math.abs(m.totalReturn * this.startCashBalance).toLocaleString('en-US'))}`);
        console.log(`Total % return    : ${m.totalReturn > 0 ? chalk.greenBright('+' + (m.totalReturn * 100).toFixed(2) + '%') : chalk.redBright('' + (m.totalReturn * 100).toFixed(2) + '%')}`);
        console.log(`Avg daily return  : ${m.avgDaily > 0 ? chalk.greenBright('+' + (m.avgDaily * 100).toFixed(2) + '%') : chalk.redBright('' + (m.avgDaily * 100).toFixed(2) + '%')}`);
        console.log(`CAGR (Annualized) : ${m.CAGR > 0 ? chalk.greenBright('+' + (m.CAGR * 100).toFixed(1) + '%') : chalk.redBright('' + (m.CAGR * 100).toFixed(1) + '%')}`);
        console.log(`Max draw-down     : ${(m.maxDrawdown * 100).toFixed(1) + '%'}`);
        console.log(`Geo-mean period   : ${m.geoPeriodRet > 0 ? chalk.greenBright('+' + (m.geoPeriodRet * 100).toFixed(2) + '%') : chalk.redBright('' + (m.geoPeriodRet * 100).toFixed(2) + '%')}  (annual ≈ ${(m.geoAnnualRet * 100).toFixed(1)}%)`);
        console.log(`Geo-mean annual   : ${m.geoAnnualRet > 0 ? chalk.greenBright('+' + (m.geoAnnualRet * 100).toFixed(2) + '%') : chalk.redBright('' + (m.geoAnnualRet * 100).toFixed(2) + '%')}`);

        const sharpeColor = m.sharpe > 3 ? 'cyanBright' : m.sharpe > 2 ? 'greenBright' : m.sharpe > 1 ? 'yellowBright' : 'redBright';
        console.log(`Sharpe            : ${chalk[sharpeColor](m.sharpe.toFixed(2))}`);
    }
}
