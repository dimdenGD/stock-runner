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

## Example strategy - SMA crossover
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