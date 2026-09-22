# Stock Runner

Because of lack of good algotrading tools in JavaScript, I've decided to build my own.
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

### Stooq (free, only last 6 months for 5m, 2 years for 1h, 20 years for 1d)

1. Go to [stooq.com/db/h](https://stooq.com/db/h/)
2. Download daily/hourly/5m data and place `nasdaq stocks`, etc., in `data/stooq/1d`, `data/stooq/1h`, `data/stooq/5m`
3. Ingest into QuestDB:
   ```bash
   node scripts/stooq_ingest.js <1d|1h|5m>
   ```
4. Re-run to update data.

### Binance (free, crypto futures)

1. Download klines and funding rates into `data/binance/`:
   ```bash
   node scripts/binance_download.js <interval> [startMonth] [endMonth] [--no-daily] [--tail-only]
   ```
   - Example: `node scripts/binance_download.js 15m 2023-09`
   - `interval` can be `1m`, `5m`, `15m`, `1h`, `4h`, `1d`
   - Re-run to update data.
2. Ingest into QuestDB (`crypto_candles_<interval>` and `crypto_funding`):
   ```bash
   node scripts/binance_ingest.js <interval>
   ```

### Hyperliquid (free, crypto perps)

The API serves only the latest 5000 candles per interval (4h ≈ 2.3 years, 1h ≈ 7 months, 15m ≈ 52 days).

1. Download candles and hourly funding into `data/hyperliquid/`:
   ```bash
   node scripts/hyperliquid_download.js <interval> [--coins=BTC,ETH] [--hip3] [--no-funding] [--funding-from=YYYY-MM]
   ```
   - Example: `node scripts/hyperliquid_download.js 4h`
   - `--hip3` adds builder-dex markets (tickers like `xyz:TSLA`).
   - Funding starts at each coin's first stored candle unless `--funding-from` is set.
2. Ingest into QuestDB (`hl_candles_<interval>` and `hl_funding`):
   ```bash
   node scripts/hyperliquid_ingest.js <interval>
   ```

### Massive (paid)

1. Get API key from [massive.com](https://massive.com/)
2. Set `MASSIVE_KEY` in `.env`
3. Run:
   ```bash
   node scripts/massive_download.js <period> <startDate> <skip downloaded tickers>
   ```
   - Example: `node scripts/massive_download.js 1d 2003-09-10 true`
   - `period` can be `1d`, `1h`, `5m`, `1m`
   - `startDate` is the date to start downloading from
   - `skip downloaded tickers` is a boolean flag to skip already downloaded tickers
5. Ingest into QuestDB:
   ```bash
   node scripts/massive_ingest.js <period>
   ```
   - Example: `node scripts/massive_ingest.js 1d`
   - `period` can be `1d`, `1h`, `5m`, `1m`

### Alpaca (free with an account, history from 2016)

1. Get API keys from [alpaca.markets](https://alpaca.markets/)
2. Set `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` in `.env`
   - Optional: `ALPACA_FEED` (`sip` or `iex`, default `sip`), `ALPACA_RPM` (requests per minute, default `200`), `ALPACA_TRADING_URL` (default paper API)
3. Run:
   ```bash
   node scripts/alpaca_download.js <period> <startDate> <skip downloaded tickers> <adjustment>
   ```
   - Example: `node scripts/alpaca_download.js 15m 2023-01-01 true all`
   - `period` can be `1d`, `1h`, `15m`, `5m`, `1m`
   - `startDate` defaults to the last timestamp in the table, or `2016-01-01`
   - `adjustment` can be `raw`, `split`, `dividend`, `all` (default `all`)
4. Ingest into QuestDB:
   ```bash
   node scripts/alpaca_ingest.js <period>
   ```

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
    name: 'sma',
    params: { short: 25, long: 50 },
    warmup: 0,
    intervals: {
        '1d': { count: 50, main: true },
        '1h': { count: 24, main: false },
    },
    onTick: async (context) => { /* ... */ },
});
```

- **`name`** - Used for forward test data folder. Default: script filename.
- **`params`** - Saved with forward runs.
- **`warmup`** - Bars to run before `startDate`. Orders are rejected during warmup.
- **`intervals`** - Timeframes your strategy uses. Keys: `'1d'`, `'4h'`, `'1h'`, `'15m'`, `'5m'`, `'1m'`.
  - **`count`** - Number of bars to keep in lookback (≥ 1).
  - **`main: true`** - Exactly one interval must be main; it drives the simulation (one tick per bar).
- **`onTick`** - Called every bar (single-stock) or every bar across all stocks (all-stocks). Receives a context object (see below).

### Backtest

```js
import Backtest from '../src/backtest/index.js';

const bt = new Backtest({
    strategy,
    startDate: new Date('2020-01-01'),
    endDate: new Date('2025-01-01'),
    capital: 10_000,
    broker: new IBKR('tiered'),
    logs: { swaps: false, trades: true },
    features: [ // optional
        { name: 'volume', bucketSize: 1_000_000 },
    ],
});

const result = await bt.runOnTicker('AAPL');  // single symbol
// or
const result = await bt.runOnAllTickers();    // all symbols in DB

bt.logMetrics(result);
```

- **`runOnTicker(stockName)`** - Runs backtest on one ticker; returns metrics object.
- **`runOnAllTickers()`** - Runs on all tickers with data in the range; returns metrics object.
- **`logMetrics(metrics)`** - Prints summary (CAGR, Sharpe, max drawdown, win rate, etc.) and any open positions.
- **`buildReport(metrics)`** - Builds a HTML report with charts and tables.

**Crypto options:**

- **`market`** - `'stocks'` or `'crypto'`. Crypto enables 24/7 trading. Default: `broker.market`.
- **`venue`** - Crypto data source: `'binance'` or `'hyperliquid'`.
- **`allowShort`** - Override shorting. Default: `true` for crypto, `false` for stocks.
- **`maxLeverage`** - Maximum gross exposure / equity.

**Metrics returned by `getMetrics()` / `runOnTicker` / `runOnAllTickers`:**

| Field           | Description                    |
|----------------|--------------------------------|
| `period`       | `[startDate, endDate]`         |
| `trades`       | Number of completed round-trip trades |
| `totalFees`    | Sum of broker fees             |
| `totalReturn`  | (final equity / start cash) − 1 |
| `avgDaily`     | Mean UTC-day return, from start cash |
| `geoDaily`     | Geometric mean UTC-day return  |
| `dailyWinRate` | Share of days with a positive return |
| `days`         | Number of daily returns        |
| `CAGR`         | Compound annual growth rate    |
| `sharpe`       | Annualized Sharpe ratio        |
| `maxDrawdown`  | Worst peak-to-trough decline   |
| `geoPeriodRet` | Geometric mean return per main-interval bar |
| `geoAnnualRet` | Geometric mean annualized return |
| `totalFunding` | Crypto: funding paid (positive) or received (negative) |
| `skippedOrders`, `skippedNotional` | Orders the broker's `quantize` rejected, and their requested notional |
| `quantizedOrders`, `quantizedDrift` | Orders rounded down to a lot boundary, and the notional lost to rounding |
| `ruined`       | Crypto: equity hit zero and the run stopped |

### onTick context

**Single-stock** (`runOnTicker`):

- `stockName`, `candle` (current bar), `stockBalance`, `ctx` (backtest instance)
- `getCandles(intervalName, count, ts?)` - Returns Promise of newest-first bars including the current bar, or `null` when fewer than `count` exist.
- `buy(quantity, price)`, `sell(quantity, price)` - execute at given price (fees applied by broker).
- `setFeatures(features)` - set features for the trade. Used for calculating profit correlations. You must set `features` in Backtest options. for example: `.setFeatures([0.1, 0.2, 0.3])`

**All-stocks** (`runOnAllTickers`):

- `currentDate`, `ctx`, `stocks` (array of per-stock objects)
- Each element of `stocks` has: `stockName`, `candle`, `stockBalance`, `getCandles`, `buy`, `sell`, `setFeatures` (see above).
- Use `ctx.cashBalance`, `ctx.stockBalances` for portfolio state. Delisted symbols are detected and positions cleared after missing bars.

**`ctx`**:

- `totalValue()`, `grossExposure()`, `cashBalance`, `stockBalances`, `stockPrices`, `isWarmup`
- `record(kind, data)` - Saves `data` to the forward journal. `data.symbol` and numeric `data.value` get their own columns. No-op in backtest.

### Brokers

- **`Broker`** (base) - No fees, override `calculateFees(quantity, price, side)` for custom logic.
  - `quantize(symbol, signedQty, price, { reduceOnly })` - Returns the signed quantity the venue would accept, or `0` to reject.
  - `prepareBacktest()` - Awaited once before a backtest runs.
  - `executionPrice(quantity, price, side, candle)` - Modelled fill price
  - `tradingMode` - `'live'` or `'demo'`
- **`IBKR`** - Interactive Brokers:
  - `new IBKR('tiered')` or `new IBKR('fixed')`
  - Tiered: $0.0035/share, min $0.35, max 1% notional, plus a modelled $0.003/share liquidity-removal fee, $0.00020/share clearing, and commission pass-through assessments.
  - Fixed: $0.005/share, min $1, max 1% notional
  - Both: SEC $20.60/million sold, FINRA TAF $0.000195/sold share capped at $9.79, CAT $0.000003/share on buys and sells.
  - Optional second argument: slippage (decimal, e.g. `0.001` = 0.1%).
  - Optional third argument: `{ exchangeFeePerShare }`. default `0.003`
- **`Alpaca`** - Commission-free U.S. equity; regulatory fees only:
  - `new Alpaca(slippage?)`
  - Commission: $0. Sells: SEC $20.60 per $1M, FINRA TAF $0.000195/share (max $9.79). All: CAT $0.000003/share.
  - `slippage` - fraction (e.g. `0.001` = 0.1%), default `0`.
- **`BinanceFutures`** - USD-M futures. Supports forward testing:
  - `new BinanceFutures({ feeBps, slippage, impactCoef, depthRatio, environment, apiKey, apiSecret })`
  - `feeBps` - fee in basis points, default `5` (VIP0 taker).
  - `slippage` - extra fraction of notional per fill, default `0`.
  - `impactCoef` - multiplier on the book walk, default `1`
  - `depthRatio` - depth within 1% of mid, as a fraction of the bar quote volume
  - `environment` - `demo` (default) or `live`.
  - `apiKey`, `apiSecret` - needed for forward testing.
  - `strictQuantization` - throw instead of passing the order through when a symbol has no rules, default `false`.
  - `quantize` floors to `MARKET_LOT_SIZE`/`LOT_SIZE` step and rejects below `minQty` or `MIN_NOTIONAL`
- **`Hyperliquid`** - Perps on Hyperliquid. Supports forward testing:
  - `new Hyperliquid({ feeBps, slippage, impactCoef, depthRatio, environment, privateKey, accountAddress, vaultAddress })`
  - `feeBps` - default `4.5`.
  - `slippage`, `impactCoef`, `depthRatio` - as `BinanceFutures`; `depthRatio` default `0.25`.
  - `environment` - `testnet` (default) or `mainnet`.
  - `privateKey` - API wallet key, needed for orders.
  - `marketSlippage` - IOC limit offset from mid for market orders, default `0.05`.
  - `quantize` floors to `szDecimals` and rejects orders under $10 unless reduce-only.

### ForwardRunner

```js
import ForwardRunner from '../src/forward/index.js';

const runner = new ForwardRunner({
    strategy,
    broker: new BinanceFutures({ environment: 'demo', apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET }),
    capital: 50_000,
    maxLeverage: 1.1,
    logs: { swaps: false, trades: true, ticks: false },
    dryRun: false,
});

process.on('SIGINT', () => runner.stop());
await runner.run();
```

- **`capital`** - The strategy's allocation.
- **`adoptExisting`** / **`ignoreExisting`** - Required. Controls whether strategy takes over existing trades.
- **`maxLeverage`** - Max gross exposure / equity per batch. Default: `3` for crypto, `1` for stocks.
- **`dryRun`** - Run the strategy on live data without sending orders.
- **`maxNetExposure`** - Max `|net| / equity` per batch. Default: none.
- **`maxOrderNotional`** - Max notional of an opening order. Default: none.
- **`maxDailyLoss`** - Fraction of the strategy's own equity.
- **`symbols`** - Fixed universe. Default: all tradable symbols from the broker.
- **`logs.ticks`** - Print a line per bar.
- **`journalFile`** - Journal path, default `output/journal.sqlite`.
- **`journal`** - An existing `RunJournal` to write into instead of opening one.
- **`run()`** - Warms up on `strategy.warmup` bars of history, then trades on each closed bar until `stop()`.


```bash
node scripts/forward_report.js --strategy=<name> [--run=N | --runs]
```
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
    capital: 10_000,
    broker: new IBKR('tiered'),
    logs: { swaps: false, trades: true }
});

const result = await bt.runOnTicker('AAPL');
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
    capital: 100_000,
    broker: new IBKR('tiered'),
    logs: { swaps: false, trades: true }
});

const result = await bt.runOnAllTickers();
bt.logMetrics(result);
```

Result:

![image](https://lune.dimden.dev/8af93df778c2.png)
