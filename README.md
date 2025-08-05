# Stock Runner
Because of lack of good backtesting tools in JavaScript, I've decided to build my own.
It uses Polygon.io to get backtesting data, and QuestDB to efficiently store and query the data.

### Installation
1. Clone the repository
2. Install dependencies with `npm install`
3. QuestDB:
- Install from https://questdb.com/download/
- Run it with `./questdb.exe` or `./questdb`
- By default QuestDB uses `admin:quest@localhost:8812/qdb` as credentials. If you just plan on running it locally, you can leave it as is. Otherwise you can set the optional `QUESTDB_USERNAME`, `QUESTDB_PASSWORD`, `QUESTDB_HOST`, `QUESTDB_PORT`, and `QUESTDB_DATABASE` environment variables.
4. Polygon.io:
- Create an account at https://polygon.io/
- Get flat files API key at https://polygon.io/dashboard/keys
- Set the `POLYGON_ACCESS_KEY_ID` and `POLYGON_SECRET_ACCESS_KEY` environment variables.

### Getting the data
1. Run the script to download the data from Polygon to CSV files:
```
node scripts/s3download.js <1d|1m>
```
2. Run the script to import the data from CSV files to QuestDB:
```
node scripts/questIngest.js <1d|1m>
```
Importing 1m can take up to 5 hours.  
  
3. You can re-run these scripts to update the data.

### Running a backtest
1. Create a strategy in `strategies/`
2. Run the backtest:
```
node strategies/sma.js
```

## Example strategy on single stock - SMA crossover
```js
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
```
Result:  
  
![image](https://lune.dimden.dev/9157964b4648.png) 

## Example strategy on all stocks - SMA crossover
```js
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
    startDate: new Date('2024-07-14'),
    endDate: new Date('2025-07-30'),
    startCashBalance: 100_000,
    broker: new IBKR('tiered'),
    logs: {
        swaps: false,
        trades: true
    }
});

const result = await bt.runOnAllStocks();
bt.logMetrics(result);
```
Result:  
  
![image](https://lune.dimden.dev/c78c2e502eeb.png) 