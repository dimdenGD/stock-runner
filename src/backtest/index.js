import { formatDate } from '../utils.js';
import Broker from '../brokers/base.js';

const sharpePeriods = {
    '1d': 252,
    '1m': 252 * 390, // 390 minutes in a trading day
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
     * @param {number} params.startDollarBalance  – Starting cash balance
     */
    constructor({ strategy, stockName, startDate, endDate, startDollarBalance, broker }) {
        this.strategy = strategy;
        this.stockName = stockName;
        this.startDate = startDate;
        this.endDate = endDate;
        this.startDollarBalance = startDollarBalance;

        this.dollarBalance = startDollarBalance;
        this.stockBalance = 0;
        this.trades = [];
        this.equityCurve = [];
        this.broker = broker || new Broker();
        this.totalFees = 0;
    }

    /**
     * Kick off the backtest: wrap the strategy's onTick to record equity
     */
    async run() {
        // wrap onTick to snapshot equity after each tick
        const strat = this.strategy;
        const originalOn = strat.onTick;
        strat.onTick = async (ctx) => {
            await originalOn(ctx);
            // record equity at this tick
            const price = ctx.candle.close;
            const ts = ctx.candle.timestamp;
            this.record(price, ts);
        };

        // initial snapshot at startDate (use first loaded candle price)
        // will be overwritten on first tick
        this.equityCurve.push({ timestamp: this.startDate.getTime(), equity: this.startDollarBalance });

        // run the strategy
        await strat.runBacktest(this);
    }

    /**
     * Record a timestamped equity point, smoothing buys/sells
     * so equity curve flows continuously.
     * @param {number} price     – price per share at this timestamp
     * @param {number} timestamp – ms since epoch
     */
    record(price, timestamp) {
        const equity = this.totalValue(price);
        this.equityCurve.push({ timestamp, equity });
    }

    /**
     * Market buy: adjust cash, shares, log trade
     */
    buy(quantity, price, timestamp = Date.now()) {
        const cost = quantity * price;
        const fee = this.broker.calculateFees(quantity, price, 'buy');
        if (cost + fee > this.dollarBalance) {
            throw new Error(`Insufficient cash: need ${cost + fee}, have ${this.dollarBalance}`);
        }
        this.dollarBalance -= (cost + fee);
        this.stockBalance += quantity;
        this.trades.push({ type: 'buy', quantity, price, timestamp, fee });
        this.totalFees += fee;
    }

    /**
     * Market sell: adjust shares, cash, log trade
     */
    sell(quantity, price, timestamp = Date.now()) {
        if (quantity > this.stockBalance) {
            throw new Error(`Insufficient shares: have ${this.stockBalance}, trying to sell ${quantity}`);
        }
        const proceeds = quantity * price;
        const fee = this.broker.calculateFees(quantity, price, 'sell');
        this.dollarBalance += (proceeds - fee);
        this.stockBalance -= quantity;
        this.trades.push({ type: 'sell', quantity, price, timestamp, fee });
        this.totalFees += fee;
    }

    /**
     * Value of stock holdings at a given price
     */
    positionValue(price) {
        return this.stockBalance * price;
    }

    /**
     * Total account value: cash + position value
     */
    totalValue(price) {
        return this.dollarBalance + this.positionValue(price);
    }

    /**
     * Get the recorded equity curve as [{timestamp, equity}, ...]
     */
    getEquityCurve() {
        return this.equityCurve;
    }

    /**
     * Compute performance statistics: total return, annualized return,
     * max drawdown, Sharpe ratio, and trade count.
     */
    getStats() {
        const curve = this.equityCurve;
        if (curve.length < 2) {
            return {};
        }

        // extract equity and times
        const eq = curve.map(pt => pt.equity);
        const ts = curve.map(pt => pt.timestamp);
        const mainInterval = this.strategy.intervals.find(i => i.main);

        // total return
        const totalReturn = eq[eq.length - 1] / eq[0] - 1;

        // time span in days
        const days = (ts[ts.length - 1] - ts[0]) / (1000 * 60 * 60 * 24);
        const annualizedReturn = days > 0
            ? Math.pow(eq[eq.length - 1] / eq[0], 365 / days) - 1
            : 0;

        // max drawdown
        let peak = eq[0];
        let maxDD = 0;
        for (const value of eq) {
            if (value > peak) peak = value;
            const dd = (peak - value) / peak;
            if (dd > maxDD) maxDD = dd;
        }

        // daily returns for Sharpe
        const dailyRets = [];
        for (let i = 1; i < eq.length; i++) {
            dailyRets.push(eq[i] / eq[i - 1] - 1);
        }
        const avg = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
        const varr = dailyRets.reduce((a, b) => a + (b - avg) ** 2, 0) / (dailyRets.length - 1 || 1);
        const sd = Math.sqrt(varr);
        const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(sharpePeriods[mainInterval.name]) : null;

        return {
            totalReturn,
            annualizedReturn,
            maxDrawdown: maxDD,
            sharpeRatio: sharpe,
            numTrades: this.trades.length,
            totalFees: this.totalFees
        };
    }

    logResults() {
        console.log('Trades:');
        for (const trade of this.trades) {
            console.log(`[${formatDate(new Date(trade.timestamp))}] ${trade.type} ${trade.quantity} shares at ${trade.price}`);
        }

        console.log(`\n${formatDate(this.startDate)} - ${formatDate(this.endDate)} Stats:`);
        const stats = this.getStats();
        console.log(`Total return %: ${(stats.totalReturn * 100).toFixed(2)}%`);
        console.log(`Annualized return %: ${(stats.annualizedReturn * 100).toFixed(2)}%`);
        console.log(`Max drawdown %: ${(stats.maxDrawdown * 100).toFixed(2)}%`);
        console.log(`Sharpe ratio: ${stats.sharpeRatio.toFixed(2)}`);
        console.log(`Number of trades: ${stats.numTrades}`);
        console.log(`Total P&L: $${(this.startDollarBalance * (stats.totalReturn + 1) - this.startDollarBalance).toFixed(2)}`);
        console.log(`Total fees: $${stats.totalFees.toFixed(2)}`);
    }
}
