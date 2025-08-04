import Strategy from '../src/backtest/strategy.js';
import Backtest from '../src/backtest/index.js';
import IBKR from '../src/brokers/ibkr.js';

const SHORT_LEN = 25;
const LONG_LEN = SHORT_LEN * 2;

const sma = candles => candles.reduce((sum, c) => sum + c.close, 0) / candles.length;

const myStrat = new Strategy({
    intervals: [
        { name: '1d', candles: LONG_LEN, main: true },
    ],
    onTick: async ({ candle, getCandles, buy, sell, backtest }) => {
        const lastLong = getCandles('1d', LONG_LEN);
        const lastShort = lastLong.slice(0, SHORT_LEN);

        const longMA = sma(lastLong);
        const shortMA = sma(lastShort);
        const price = candle.close;

        if (backtest.stockBalance === 0 && shortMA > longMA) {
            buy(3, price);
        }
        else if (backtest.stockBalance > 0 && shortMA < longMA) {
            sell(backtest.stockBalance, price);
        }
    }
});

const bt = new Backtest({
    strategy: myStrat,
    stockName: 'GOOG',
    startDate: new Date('2020-07-14'),
    endDate: new Date('2025-07-30'),
    startDollarBalance: 10_000,
    broker: new IBKR('tiered'),
});

await bt.run();

bt.logResults();