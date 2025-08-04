import { allowedIntervals } from './consts.js';
import CandleBuffer from './candleBuffer.js';

export default class Strategy {
    /**
     * @param {Object} options
     * @param {Object[]} options.intervals         — Array of { name, candles, main }
     * @param {Function} options.onTick           — Called each tick with context
     * @throws {TypeError} on invalid intervals or onTick
     */
    constructor({ intervals, onTick }) {
        if (!Array.isArray(intervals) || intervals.length === 0) {
            throw new TypeError('Intervals must be a non-empty array');
        }
        for (const iv of intervals) {
            if (typeof iv.name !== 'string' || typeof iv.candles !== 'number') {
                throw new TypeError('Each interval needs a `name` (string) and `candles` (number)`');
            }
            if (!allowedIntervals.includes(iv.name)) {
                throw new TypeError(`Invalid interval name: ${iv.name}`);
            }
            if (iv.candles < 1) {
                throw new TypeError('Interval `candles` must be >= 1');
            }
        }
        const mains = intervals.filter(iv => iv.main);
        if (mains.length !== 1) {
            throw new TypeError('Exactly one interval must have `main: true`');
        }
        if (typeof onTick !== 'function') {
            throw new TypeError('`onTick` must be a function');
        }

        this.intervals = intervals;
        this.mainInterval = mains[0];
        this.onTick = onTick;
        this.buffers = {};
    }

    /**
     * Runs backtest for a given ticker and date range
     * @param {Backtest} backtest
     */
    async runBacktest(backtest) {
        if (!(backtest.startDate instanceof Date) || !(backtest.endDate instanceof Date)) {
            throw new TypeError('`startDate` and `endDate` must be Date instances');
        }
        if (backtest.startDate >= backtest.endDate) {
            throw new TypeError('`startDate` must be before `endDate`');
        }

        // initialize buffers for each interval
        for (const iv of this.intervals) {
            this.buffers[iv.name] = new CandleBuffer(
                backtest.stockName,
                iv.name,
                backtest.startDate,
                backtest.endDate,
                iv.candles
            );
        }

        // preload initial chunks
        await Promise.all(
            Object.values(this.buffers).map(buf => buf.ensure(backtest.startDate))
        );

        const mainBuf = this.buffers[this.mainInterval.name].buffer;
        const lookback = this.mainInterval.candles;

        // iterate once we have full lookback
        for (let i = lookback - 1; i < mainBuf.length; i++) {
            const mainCandle = mainBuf[i];
            const ts = mainCandle.timestamp;
            if (ts >= backtest.endDate) break;

            // top up all buffers as we advance
            await Promise.all(
                Object.values(this.buffers).map(buf => buf.ensure(ts))
            );

            // invoke strategy
            await this.onTick({
                candle: mainCandle,
                getCandles: (intervalName, count) => this.buffers[intervalName].getLast(count, ts),
                backtest: backtest,
                buy: (quantity, price) => backtest.buy(quantity, price, mainCandle.timestamp),
                sell: (quantity, price) => backtest.sell(quantity, price, mainCandle.timestamp),
            });
        }
    }
}
