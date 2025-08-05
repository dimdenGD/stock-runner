import Strategy from '../src/backtest/strategy.js';
import Backtest from '../src/backtest/index.js';
import IBKR from '../src/brokers/ibkr.js';

const SHORT_LEN = 25;
const LONG_LEN = SHORT_LEN * 2;

const sma = candles => candles.reduce((sum, c) => sum + c.close, 0) / candles.length;

const smaCrossover = new Strategy({
    intervals: {
        '1d': { count: LONG_LEN, main: true },
    },
    onTick: async ({ candle, getCandles, buy, sell, stockBalance }) => {
        const lastLong = getCandles('1d', LONG_LEN);
        const lastShort = getCandles('1d', SHORT_LEN);

        const longMA = sma(lastLong);
        const shortMA = sma(lastShort);
        const price = candle.close;

        if (stockBalance === 0 && shortMA > longMA) {
            buy(3, price);
        }
        else if (stockBalance > 0 && shortMA < longMA) {
            sell(stockBalance, price);
        }
    }
});

const bt = new Backtest({
    strategy: smaCrossover,
    startDate: new Date('2020-07-14'),
    endDate: new Date('2025-07-30'),
    startCashBalance: 10_000,
    broker: new IBKR('tiered'),
    logs: {
        swaps: false,
        trades: true
    }
});

const result = await bt.runOnStock('AAPL');
bt.logMetrics(result);