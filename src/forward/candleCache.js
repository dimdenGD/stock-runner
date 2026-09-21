import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Candle from '../backtest/candle.js';
import Stock from '../backtest/stock.js';
import { intervalMsMap } from '../backtest/consts.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL,
    ts INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    quote_volume REAL,
    PRIMARY KEY (symbol, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS coverage (
    symbol TEXT PRIMARY KEY,
    from_ts INTEGER NOT NULL,
    to_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS consumers (
    name TEXT PRIMARY KEY,
    bars INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
);
`;

export default class CandleCache {
    constructor({ file, stepMs, retentionDays = 30 }) {
        mkdirSync(dirname(file), { recursive: true });
        this.stepMs = stepMs;
        this.retentionMs = retentionDays * 86400000;
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
        this.db.exec(SCHEMA);
        this.sql = {
            range: this.db.prepare('SELECT ts, open, high, low, close, volume, quote_volume FROM candles WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts'),
            coverage: this.db.prepare('SELECT from_ts, to_ts FROM coverage WHERE symbol = ?'),
            upsert: this.db.prepare('INSERT OR REPLACE INTO candles (symbol, ts, open, high, low, close, volume, quote_volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
            setCoverage: this.db.prepare('INSERT OR REPLACE INTO coverage (symbol, from_ts, to_ts) VALUES (?, ?, ?)'),
            extendCoverage: this.db.prepare('UPDATE coverage SET to_ts = ? WHERE symbol = ? AND to_ts >= ? AND to_ts < ?'),
            consumer: this.db.prepare('INSERT OR REPLACE INTO consumers (name, bars, seen_at) VALUES (?, ?, ?)'),
            maxBars: this.db.prepare('SELECT MAX(bars) AS bars FROM consumers WHERE seen_at >= ?'),
            pruneCandles: this.db.prepare('DELETE FROM candles WHERE ts < ?'),
            pruneCoverage: this.db.prepare('UPDATE coverage SET from_ts = ? WHERE from_ts < ?'),
            dropEmptyCoverage: this.db.prepare('DELETE FROM coverage WHERE to_ts < from_ts'),
        };
    }

    transaction(fn) {
        this.db.exec('BEGIN');
        try {
            const out = fn();
            this.db.exec('COMMIT');
            return out;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    coverage(symbol) {
        return this.sql.coverage.get(symbol) ?? null;
    }

    load(symbol, fromTs, toTs) {
        return this.sql.range.all(symbol, fromTs, toTs).map(r => new Candle(r.open, r.high, r.low, r.close, r.volume, r.ts, r.quote_volume));
    }

    store(symbol, candles, { fromTs, toTs }) {
        this.transaction(() => {
            for (const c of candles) {
                this.sql.upsert.run(symbol, c.timestamp, c.open, c.high, c.low, c.close, c.volume, c.quoteVolume ?? null);
            }
            this.sql.setCoverage.run(symbol, fromTs, toTs);
        });
    }

    append(timestamp, candles) {
        this.transaction(() => {
            for (const { symbol, candle } of candles) {
                if (candle.timestamp !== timestamp) continue;
                this.sql.upsert.run(symbol, candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.quoteVolume ?? null);
                this.sql.extendCoverage.run(timestamp, symbol, timestamp - this.stepMs, timestamp);
            }
        });
    }

    registerConsumer(name, bars) {
        this.sql.consumer.run(name, bars, Date.now());
    }

    prune(latestTs) {
        const bars = this.sql.maxBars.get(Date.now() - this.retentionMs)?.bars;
        if (!(bars > 0)) return 0;
        const cutoff = latestTs - bars * this.stepMs - 86400000;
        return this.transaction(() => {
            const removed = Number(this.sql.pruneCandles.run(cutoff).changes);
            this.sql.pruneCoverage.run(cutoff, cutoff);
            this.sql.dropEmptyCoverage.run();
            return removed;
        });
    }

    close() {
        this.db.close();
    }
}

export class CandleCacheSource {
    constructor({ directory, archive = null, logger = null }) {
        this.directory = directory;
        this.archive = archive;
        this.logger = logger;
        this.databases = new Map();
        this.retention = new Map();
        this.announced = new Set();
    }

    retained(interval) {
        if (this.retention.has(interval)) return this.retention.get(interval);
        const rows = this.database(interval)
            .prepare('SELECT symbol, MIN(ts) AS first FROM candles GROUP BY symbol').all();
        const firsts = rows.map((row) => Number(row.first)).filter(Number.isFinite);
        const retained = {
            from: firsts.length ? Math.min(...firsts) : null,
            symbols: new Set(rows.map((row) => row.symbol)),
        };
        this.retention.set(interval, retained);
        return retained;
    }

    database(interval) {
        if (this.databases.has(interval)) return this.databases.get(interval);
        const file = join(this.directory, `${interval}.sqlite`);
        if (!existsSync(file)) throw new Error(`forward candle cache is unavailable for ${interval}`);
        const db = new DatabaseSync(file, { readOnly: true });
        db.exec('PRAGMA busy_timeout = 5000;');
        this.databases.set(interval, db);
        return db;
    }

    async *streamAllStocksInRange(interval, startDate, endDate, market = 'crypto') {
        const start = startDate.getTime();
        const end = endDate.getTime();
        const { from, symbols } = this.retained(interval);
        let cacheStart = start;
        if (this.archive && from != null && start < from) {
            const archiveEnd = Math.min(end, from - 1);
            let yielded = 0;
            try {
                const older = this.archive.streamAllStocksInRange(interval, startDate, new Date(archiveEnd), market);
                for await (const record of older) {
                    if (!symbols.has(record.stockName)) continue;
                    yielded++;
                    yield record;
                }
            } catch (error) {
                if (yielded) throw error;
                this.logger?.warn?.(`candle cache: archive unavailable before ${new Date(from).toISOString()}; `
                    + `those bars are replayed without history the runner had: ${error.message}`);
            }
            if (yielded && !this.announced.has(interval)) {
                this.announced.add(interval);
                this.logger?.log?.(`candle cache: bars before ${new Date(from).toISOString()} were pruned; `
                    + 'taking them from the archive');
            }
            cacheStart = from;
        }
        if (end < cacheStart) return;
        const rows = this.database(interval).prepare(
            `SELECT symbol, ts, open, high, low, close, volume, quote_volume
             FROM candles WHERE ts >= ? AND ts <= ? ORDER BY ts ASC, symbol ASC`,
        ).iterate(Math.max(start, cacheStart), end);
        for (const row of rows) {
            yield {
                stockName: row.symbol,
                candle: new Candle(row.open, row.high, row.low, row.close, row.volume, row.ts, row.quote_volume),
            };
        }
    }

    async loadStockBeforeTimestamp(symbol, interval, date, count, market = 'crypto') {
        const { from } = this.retained(interval);
        if (this.archive && from != null && date.getTime() < from) {
            return this.archive.loadStockBeforeTimestamp(symbol, interval, date, count, market);
        }
        const stock = new Stock(symbol, intervalMsMap[interval]);
        const rows = this.database(interval).prepare(
            `SELECT ts, open, high, low, close, volume, quote_volume
             FROM candles WHERE symbol = ? AND ts <= ? ORDER BY ts DESC LIMIT ?`,
        ).all(symbol, date.getTime(), count);
        for (const row of rows) {
            stock.pushValues(row.open, row.high, row.low, row.close, row.volume, row.ts, row.quote_volume);
        }
        stock.finish();
        return stock;
    }

    close() {
        for (const db of this.databases.values()) db.close();
        this.databases.clear();
    }
}
