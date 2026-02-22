# Stock Runner

Because of lack of good backtesting tools in JavaScript, I've decided to build my own.
It uses QuestDB to efficiently store and query the data.
It's also quite fast and nice to use. You can run a 5 year backtest on ALL stocks in 1 minute (on daily ticks).

## Installation

1. Clone the repository.
2. Install dependencies: `npm install`
3. **QuestDB**
   - Download from [questdb.com/download](https://questdb.com/download/)
   - Run: `./questdb` (or `./questdb.exe` on Windows)
   - Default: `admin:quest@localhost:8812/qdb`. For custom setup, set:
     - `QUESTDB_USERNAME`, `QUESTDB_PASSWORD`
     - `QUESTDB_HOST`, `QUESTDB_PORT`, `QUESTDB_DATABASE`

---

## Getting the data

### Stooq (free, split-adjusted)

1. Go to [stooq.com/db/h](https://stooq.com/db/h/)
2. Download daily/hourly/5m data and place `nasdaq stocks`, etc., in `data/stooq/`
3. Ingest into QuestDB:
   ```bash
   node scripts/stooq_ingest.js <1d|1h|5m>
   ```
4. Re-run to update data.

### Polygon.io (paid, not split-adjusted)

1. Sign up at [polygon.io](https://polygon.io/) and get flat files API keys from the dashboard.
2. Set `POLYGON_ACCESS_KEY_ID` and `POLYGON_SECRET_ACCESS_KEY`.
3. Download to CSV:
   ```bash
   node scripts/polygon_download.js <1d|1m>
   ```
4. Ingest into QuestDB:
   ```bash
   node scripts/polygon_ingest.js <1d|1m>
   ```
   (1m ingest can take several hours.)

---

## Running a backtest

1. Add a strategy file under `strategies/` (see examples below).
2. Run it, e.g.:
   ```bash
   node strategies/sma.js
   ```

---

## API reference

### Strategy

```js
import Strategy from '../src/backtest/strategy.js';

const strategy = new Strategy({
    intervals: {
        '1d': { count: 50, main: true },
        '1h': { count: 24, main: false, preload: true },
    },
    onTick: async (context) => { /* ... */ },
});
```

- **`intervals`** - Timeframes your strategy uses. Keys: `'1d'`, `'1h'`, `'5m'`, `'1m'`.
  - **`count`** - Number of bars to keep in lookback (≥ 1).
  - **`main: true`** - Exactly one interval must be main; it drives the simulation (one tick per bar).
  - **`preload`** - If `true`, bars are preloaded for speed; non-main intervals can set this to avoid on-demand DB reads.
- **`onTick`** - Called every bar (single-stock) or every bar across all stocks (all-stocks). Receives a context object (see below).

### Backtest

```js
import Backtest from '../src/backtest/index.js';

const bt = new Backtest({
    strategy,
    startDate: new Date('2020-01-01'),
    endDate: new Date('2025-01-01'),
    startCashBalance: 10_000,
    broker: new IBKR('tiered'),
    logs: { swaps: false, trades: true },
});

const result = await bt.runOnStock('AAPL');   // single symbol
// or
const result = await bt.runOnAllStocks();     // all symbols in DB

bt.logMetrics(result);
```

- **`runOnStock(stockName)`** - Runs backtest on one ticker; returns metrics object.
- **`runOnAllStocks()`** - Runs on all tickers with data in the range; returns metrics object.
- **`logMetrics(metrics)`** - Prints summary (CAGR, Sharpe, max drawdown, win rate, etc.) and any open positions.

**Metrics returned by `getMetrics()` / `runOnStock` / `runOnAllStocks`:**

| Field           | Description                    |
|----------------|--------------------------------|
| `period`       | `[startDate, endDate]`         |
| `trades`       | Number of completed round-trip trades |
| `totalFees`    | Sum of broker fees             |
| `totalReturn`  | (final equity / start cash) − 1 |
| `avgDaily`     | Average period return          |
| `CAGR`         | Compound annual growth rate    |
| `sharpe`       | Annualized Sharpe ratio        |
| `maxDrawdown`  | Worst peak-to-trough decline   |
| `geoPeriodRet` | Geometric mean period return   |
| `geoAnnualRet` | Geometric mean annualized return |

### onTick context

**Single-stock** (`runOnStock`):

- `stockName`, `candle` (current bar), `stockBalance`, `ctx` (backtest instance)
- `getCandles(intervalName, count, ts?)` - returns `Promise<Array>` of bars (newest to oldest); `ts` defaults to current bar.
- `buy(quantity, price)`, `sell(quantity, price)` - execute at given price (fees applied by broker).

**All-stocks** (`runOnAllStocks`):

- `currentDate`, `ctx`, `stocks` (array of per-stock objects), `raw` (all loaded symbols)
- Each element of `stocks` has: `stockName`, `candle`, `stockBalance`, `getCandles`, `buy`, `sell` (see above).
- Use `ctx.cashBalance`, `ctx.stockBalances` for portfolio state. Delisted symbols are detected and positions cleared after missing bars.

### Brokers

- **`Broker`** (base) - No fees; override `calculateFees(quantity, price, side)` for custom logic.
- **`IBKR`** - Interactive Brokers:
  - `new IBKR('tiered')` or `new IBKR('fixed')`
  - Tiered: $0.0035/share, min $0.35, max 1% notional + clearing/regulatory.
  - Fixed: $0.005/share, min $1, max 1% notional.
  - Optional second argument: slippage (decimal, e.g. `0.001` = 0.1%).

---

## Strategies

### Single stock - SMA crossover

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
        const lastLong = await getCandles('1d', LONG_LEN);
        const lastShort = await getCandles('1d', SHORT_LEN);

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
    logs: { swaps: false, trades: true }
});

const result = await bt.runOnStock('AAPL');
bt.logMetrics(result);
```

Result:

![image](https://lune.dimden.dev/9157964b4648.png)

### All stocks - SMA crossover

```js
import Strategy from '../src/backtest/strategy.js';
import Backtest from '../src/backtest/index.js';
import IBKR from '../src/brokers/ibkr.js';

const SHORT_LEN = 14;
const LONG_LEN = SHORT_LEN * 2;

const sma = candles => candles.reduce((sum, c) => sum + c.close, 0) / candles.length;

const smaCrossover = new Strategy({
    intervals: {
        '1d': { count: LONG_LEN, main: true },
    },
    onTick: async ({ stocks, currentDate, ctx }) => {
        for (const s of stocks) {
            const { stockName, candle, getCandles, buy, sell, stockBalance } = s;

            try {
                const lastLong = await getCandles('1d', LONG_LEN);
                const lastShort = await getCandles('1d', SHORT_LEN);

                if (!lastLong || !lastShort) {
                    continue;
                }

                const longMA = sma(lastLong);
                const shortMA = sma(lastShort);
                const price = candle.close;

                if (stockBalance === 0 && shortMA > longMA) {
                    const perNameBudget = ctx.cashBalance / 10;
                    if (Object.values(ctx.stockBalances).length < 10) {
                        const qty = Math.floor(perNameBudget / price);
                        if (qty > 0) buy(qty, price);
                    }
                }
                else if (stockBalance > 0 && shortMA < longMA) {
                    sell(stockBalance, price);
                }
            } catch (_) {
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
    logs: { swaps: false, trades: true }
});

const result = await bt.runOnAllStocks();
bt.logMetrics(result);
```

Result:

![image](https://lune.dimden.dev/8af93df778c2.png)
