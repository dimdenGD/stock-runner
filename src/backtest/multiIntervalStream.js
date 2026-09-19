import chalk from 'chalk';
import ms from 'ms';
import { subDays } from 'date-fns';
import { formatDate } from '../utils.js';
import { intervalMsMap } from './consts.js';
import { loadFundingInRange, loadStockBeforeTimestamp, streamAllStocksInRange } from './loader.js';

const chunkBarsByInterval = {
    '1d': 250,
    '4h': 250,
    '1h': 500,
    '15m': 500,
    '5m': 1000,
    '1m': 2000,
};

export class CandleRing {
    constructor(capacity) {
        this.capacity = Math.max(1, capacity);
        this.values = new Array(this.capacity);
        this.start = 0;
        this.size = 0;
    }

    push(candle) {
        if (this.size < this.capacity) {
            this.values[(this.start + this.size) % this.capacity] = candle;
            this.size++;
            return;
        }
        this.values[this.start] = candle;
        this.start = (this.start + 1) % this.capacity;
    }

    getLast(count, timestamp) {
        if (count > this.size) return null;
        const out = [];
        for (let offset = this.size - 1; offset >= 0 && out.length < count; offset--) {
            const candle = this.values[(this.start + offset) % this.capacity];
            if (candle.timestamp <= timestamp) out.push(candle);
        }
        return out.length === count ? out : null;
    }
}

export class GroupedCandleReader {
    constructor(iterable) {
        this.iterator = iterable[Symbol.asyncIterator]();
        this.pending = null;
        this.done = false;
    }

    async prime() {
        if (this.pending || this.done) return;
        const next = await this.iterator.next();
        this.done = next.done;
        this.pending = next.done ? null : next.value;
    }

    async nextGroup() {
        await this.prime();
        if (this.done) return null;
        const timestamp = this.pending.candle.timestamp;
        const records = [];
        while (this.pending && this.pending.candle.timestamp === timestamp) {
            records.push(this.pending);
            const next = await this.iterator.next();
            this.done = next.done;
            this.pending = next.done ? null : next.value;
        }
        return { timestamp, records };
    }

    async advanceTo(timestamp, consume) {
        await this.prime();
        while (this.pending && this.pending.candle.timestamp <= timestamp) {
            await consume(await this.nextGroup());
        }
    }

    async close() {
        if (!this.done && typeof this.iterator.return === 'function') await this.iterator.return();
        this.pending = null;
        this.done = true;
    }
}

const historyCapacity = interval => Math.max(8, interval.count * 4);

function queryStartFor(timestamp, intervalName, capacity, market) {
    const intervalMs = intervalMsMap[intervalName];
    if (market === 'crypto') return new Date(timestamp - (capacity + 1) * intervalMs);
    if (intervalName === '1d') return subDays(new Date(timestamp), capacity * 2 + 14);
    const sessions = Math.ceil((capacity * intervalMs) / (6.5 * 3600000));
    return subDays(new Date(timestamp), Math.ceil(sessions * 7 / 5) + 7);
}

export async function runAllTickersStream(backtest) {
    const mainInterval = backtest.strategy.mainInterval.name;
    const mainIntervalMs = intervalMsMap[mainInterval];
    const chunkBars = chunkBarsByInterval[mainInterval];
    const rangeStart = backtest.warmupStart.getTime();
    const rangeEnd = backtest.endDate.getTime();
    const chunkSpan = chunkBars * mainIntervalMs;
    const chunkCount = Math.ceil((rangeEnd - rangeStart + 1) / chunkSpan);
    const intervalEntries = Object.entries(backtest.strategy.intervals);
    const capacities = Object.fromEntries(intervalEntries.map(([name, interval]) => [name, historyCapacity(interval)]));
    const histories = Object.fromEntries(intervalEntries.map(([name]) => [name, new Map()]));
    const advancedThrough = Object.fromEntries(intervalEntries.map(([name]) => [name, -Infinity]));
    const fallbackCache = new Map();
    const streamRange = backtest.candleSource
        ? backtest.candleSource.streamAllStocksInRange.bind(backtest.candleSource)
        : streamAllStocksInRange;
    const loadBefore = backtest.candleSource
        ? backtest.candleSource.loadStockBeforeTimestamp.bind(backtest.candleSource)
        : loadStockBeforeTimestamp;
    const excluded = await backtest.broker.excludedSymbols();
    const started = Date.now();
    let previousMainTimestamp = null;

    if (backtest.market === 'crypto') {
        backtest.fundingEvents = await loadFundingInRange(new Date(rangeStart - 86400000), backtest.endDate);
    }

    const fallback = (stockName, intervalName, timestamp, count) => {
        const key = `${stockName}\0${intervalName}\0${timestamp}\0${count}`;
        if (fallbackCache.has(key)) return fallbackCache.get(key);
        const pending = loadBefore(
            stockName,
            intervalName,
            new Date(timestamp),
            count * 2,
            backtest.market,
        ).then(stock => stock.size < count ? null : [...stock].slice(0, count));
        fallbackCache.set(key, pending);
        if (fallbackCache.size > 10000) fallbackCache.delete(fallbackCache.keys().next().value);
        return pending;
    };

    const pushGroup = (intervalName, group) => {
        if (!group || group.timestamp <= advancedThrough[intervalName]) return;
        const intervalHistories = histories[intervalName];
        const capacity = capacities[intervalName];
        for (const { stockName, candle } of group.records) {
            let history = intervalHistories.get(stockName);
            if (!history) {
                history = new CandleRing(capacity);
                intervalHistories.set(stockName, history);
            }
            history.push(candle);
        }
        advancedThrough[intervalName] = group.timestamp;
    };

    const processMainGroup = async (timestamp, records, symbolOrder) => {
        const currentDate = new Date(timestamp);
        backtest.isWarmup = backtest.strategy.warmup > 0 && timestamp < backtest.startDate.getTime();
        const ordered = [];
        for (const record of records) {
            if (!excluded.has(record.stockName)) ordered[symbolOrder.get(record.stockName)] = record;
        }
        const activeRecords = ordered.filter(Boolean);
        if (!activeRecords.length) return;
        const stocks = new Array(activeRecords.length);

        for (let i = 0; i < activeRecords.length; i++) {
            const { stockName, candle } = activeRecords[i];
            backtest._markPrice(stockName, candle.close);
            if (backtest.market === 'crypto' && candle.volume > 0) {
                backtest.lastSeen[stockName] = candle.timestamp;
            }
            const item = {
                stockName,
                candle,
                stockBalance: backtest.stockBalances[stockName] || 0,
                _features: null,
                features: backtest.stockFeatures[stockName] ?? null,
                setFeatures(features) { this._features = features; },
                getCandles: (intervalName, count, at = currentDate) => {
                    const interval = backtest.strategy.intervals[intervalName];
                    if (!interval) {
                        throw new Error(`Interval ${intervalName} not found. You need to request it in the strategy constructor.`);
                    }
                    const requestedTimestamp = at instanceof Date ? at.getTime() : +at;
                    if (requestedTimestamp > timestamp) {
                        throw new Error(`Requested candles in the future: ${new Date(requestedTimestamp).toISOString()} > ${currentDate.toISOString()}`);
                    }
                    const candles = histories[intervalName].get(stockName)?.getLast(count, requestedTimestamp);
                    return candles ?? fallback(stockName, intervalName, requestedTimestamp, count);
                },
                buy: (quantity, price) => backtest.buy(stockName, quantity, price, currentDate, item._features, candle),
                sell: (quantity, price) => backtest.sell(stockName, quantity, price, currentDate, candle),
            };
            stocks[i] = item;
        }

        if (backtest.market === 'crypto') {
            backtest.applyFunding(previousMainTimestamp ?? timestamp, timestamp);
            previousMainTimestamp = timestamp;
            for (const stockName in backtest.stockBalances) {
                if (timestamp - (backtest.lastSeen[stockName] ?? timestamp) > 3 * 86400000) {
                    backtest.settle(stockName, currentDate);
                }
            }
            if (backtest.totalValue() <= 0) {
                backtest.ruined = true;
                console.log(chalk.red(`ACCOUNT LIQUIDATED ON ${formatDate(currentDate)}`));
                if (!backtest.isWarmup) backtest.recordEquity(currentDate, backtest.totalValue(), backtest.cashBalance);
                return;
            }
        } else if (Object.keys(backtest.stockBalances).length) {
            const activeSymbols = new Set(stocks.map(stock => stock.stockName));
            for (const stockName in backtest.stockBalances) {
                if (!activeSymbols.has(stockName)) {
                    backtest.delistCounter[stockName] = (backtest.delistCounter[stockName] || 0) + 1;
                    if (backtest.delistCounter[stockName] > 10) {
                        delete backtest.stockBalances[stockName];
                        backtest._invalidateValuation();
                        console.log(chalk.red(`${stockName} DELISTED ON ${formatDate(currentDate)}`));
                    }
                }
            }
        }

        await backtest.strategy.onTick({ currentDate, ctx: backtest, stocks });
        if (!backtest.isWarmup) backtest.recordEquity(currentDate, backtest.totalValue(), backtest.cashBalance);
    };

    let chunkIndex = 0;
    for (let chunkStart = rangeStart; chunkStart <= rangeEnd && !backtest.ruined; chunkStart += chunkSpan) {
        const chunkEndExclusive = Math.min(rangeEnd + 1, chunkStart + chunkSpan);
        const readers = {};
        for (const [intervalName] of intervalEntries) {
            const queryStart = queryStartFor(chunkStart, intervalName, capacities[intervalName], backtest.market);
            readers[intervalName] = new GroupedCandleReader(streamRange(
                intervalName,
                queryStart,
                new Date(chunkEndExclusive - 1),
                backtest.market,
            ));
        }
        await Promise.all(Object.values(readers).map(reader => reader.prime()));
        if (backtest.logs.progress !== false) {
            console.log(`++++++++++++++++++++ ${((chunkIndex / chunkCount) * 100).toFixed(2)}%`);
        }
        chunkIndex++;

        const symbolOrder = new Map();
        let nextOrder = 0;
        const mainReader = readers[mainInterval];
        let mainGroup;
        while (!backtest.ruined && (mainGroup = await mainReader.nextGroup())) {
            for (const record of mainGroup.records) {
                if (!symbolOrder.has(record.stockName)) symbolOrder.set(record.stockName, nextOrder++);
            }
            if (mainGroup.timestamp <= advancedThrough[mainInterval]) continue;
            pushGroup(mainInterval, mainGroup);
            if (mainGroup.timestamp < chunkStart || mainGroup.timestamp >= chunkEndExclusive) continue;

            for (const [intervalName] of intervalEntries) {
                if (intervalName === mainInterval) continue;
                await readers[intervalName].advanceTo(mainGroup.timestamp, group => pushGroup(intervalName, group));
            }
            await processMainGroup(mainGroup.timestamp, mainGroup.records, symbolOrder);
        }
        await Promise.all(Object.values(readers).map(reader => reader.close()));
    }

    backtest.isWarmup = false;
    console.log('Backtest finished in', ms(Date.now() - started));
    return backtest.getMetrics();
}
