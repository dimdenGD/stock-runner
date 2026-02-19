import Strategy from '../src/backtest/strategy.js';
import Backtest from '../src/backtest/index.js';
import IBKR from '../src/brokers/ibkr.js';

const SHORT_LEN = 14;
const LONG_LEN = SHORT_LEN * 2;
const MAX_POS_PER_STOCK = 50_000; // Maximum position size per stock

const sma = candles => candles.reduce((sum, c) => sum + c.close, 0) / candles.length;

const smaCrossover = new Strategy({
    intervals: {
        '1d': { count: LONG_LEN, main: true },
    },
    onTick: async ({ stocks, currentDate, ctx }) => {
        // Process each filtered stock
        for (const s of stocks) {
            const { stockName, candle, getCandles, buy, sell, stockBalance } = s;
            
            try {
                const lastLong = getCandles('1d', LONG_LEN);
                const lastShort = getCandles('1d', SHORT_LEN);

                if (!lastLong || !lastShort || lastLong.length < LONG_LEN || lastShort.length < SHORT_LEN) {
                    continue; // Skip if we don't have enough data
                }

                const longMA = sma(lastLong);
                const shortMA = sma(lastShort);
                const price = candle.close;

                // Buy signal: short MA crosses above long MA and we have no position
                if (stockBalance === 0 && shortMA > longMA) {
                    const perNameBudget = Math.min(ctx.cashBalance / 10, MAX_POS_PER_STOCK); // Divide cash among up to 10 positions
                    if (Object.values(ctx.stockBalances).length < 10) {
                        const qty = Math.floor(perNameBudget / price);
                        if (qty > 0) {
                            buy(qty, price);
                        }
                    }
                }
                // Sell signal: short MA crosses below long MA and we have a position
                else if (stockBalance > 0 && shortMA < longMA) {
                    sell(stockBalance, price);
                }
            } catch (error) {
                // Skip this stock if there's an error (e.g., insufficient data)
                continue;
            }
        }
    }
});

const bt = new Backtest({
    strategy: smaCrossover,
    startDate: new Date('2025-09-14'),
    endDate: new Date('2026-02-12'),
    startCashBalance: 100_000,
    broker: new IBKR('tiered'),
    logs: {
        swaps: false,
        trades: true
    }
});

const result = await bt.runOnAllStocks();
bt.logMetrics(result);