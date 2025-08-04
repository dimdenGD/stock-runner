import Strategy    from '../backtest/strategy.js';
import Backtest    from '../backtest/index.js';

const SHORT_LEN = 14;
const LONG_LEN  = SHORT_LEN * 2;

// simple SMA helper
const sma = candles => 
  candles.reduce((sum, c) => sum + c.close, 0) / candles.length;

// 1) define your strategy
const myStrat = new Strategy({
  intervals: [
    { name: '1m', candles: LONG_LEN, main: true },  // we need at least 50 bars
  ],
  onTick: async ({ candle, getCandles, buy, sell, backtest }) => {
    // fetch the last 50 daily closes (reverse-chronological)
    const lastLong = getCandles('1m', LONG_LEN);
    const lastShort = lastLong.slice(0, SHORT_LEN);

    const longMA  = sma(lastLong);
    const shortMA = sma(lastShort);
    const price   = candle.close;

    // only go long if flat and shortMA > longMA
    if (backtest.stockBalance === 0 && shortMA > longMA) {
      buy(10, price);
    }
    // only exit if we have shares and shortMA < longMA
    else if (backtest.stockBalance > 0 && shortMA < longMA) {
      sell(backtest.stockBalance, price);
    }
  }
});

// 2) run it
(async () => {
  const bt = new Backtest({
    strategy:           myStrat,
    stockName:          'AAPL',
    startDate:          new Date('2025-07-14'),
    endDate:            new Date(),
    startDollarBalance: 10_000,
  });

  await bt.run();

  console.log('Final cash:  ', bt.dollarBalance.toFixed(2));
  console.log('Final shares:', bt.stockBalance);
})();