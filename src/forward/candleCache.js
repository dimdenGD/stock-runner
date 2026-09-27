import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Candle from '../backtest/candle.js';
import Stock from '../backtest/stock.js';
import { intervalMsMap } from '../backtest/consts.js';
import { openDataset } from '../data/store.js';

const FIELDS = ['open', 'high', 'low', 'close', 'volume', 'quoteVolume'];

const spanFor = (stepMs) => (stepMs <= 60000 ? 'hour' : stepMs <= 900000 ? 'day' : stepMs <= 3600000 ? 'month' : 'year');

function seriesOf(candles) {
    const n = candles.length;
    const out = { ts: new Float64Array(n) };
    for (const f of FIELDS) out[f] = new Float64Array(n);
    candles.forEach((c, i) => {
        out.ts[i] = c.timestamp;
        out.open[i] = c.open;
        out.high[i] = c.high;
        out.low[i] = c.low;
        out.close[i] = c.close;
        out.volume[i] = c.volume;
        out.quoteVolume[i] = c.quoteVolume ?? NaN;
    });
    return out;
}

const candleAt = (s, i) => new Candle(s.open[i], s.high[i], s.low[i], s.close[i], s.volume[i], s.ts[i], s.quoteVolume[i]);

function candlesIn(series, fromTs, toTs) {
    const out = [];
    if (!series) return out;
    for (let i = 0; i < series.ts.length; i++) {
        if (series.ts[i] >= fromTs && series.ts[i] <= toTs) out.push(candleAt(series, i));
    }
    return out;
}

export default class CandleCache {
    constructor({ file = null, directory = null, interval = null, stepMs, retentionDays = 30 }) {
        const dir = directory && interval ? join(directory, interval) : String(file).replace(/\.sqlite$/, '');
        this.stepMs = stepMs;
        this.retentionMs = retentionDays * 86400000;
        this.ds = openDataset(dir, { create: true, fields: FIELDS, step: stepMs, partition: spanFor(stepMs) });
        this.consumersFile = join(dir, 'consumers.json');
        this.pending = new Map();
        this.preloaded = null;
        const legacy = `${dir}.sqlite`;
        if (existsSync(legacy)) this.migrate(legacy);
    }

    migrate(file) {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            const writer = this.ds.bulk({ fields: FIELDS });
            for (const r of db.prepare('SELECT symbol, ts, open, high, low, close, volume, quote_volume FROM candles ORDER BY symbol, ts').iterate()) {
                writer.push(r.symbol, r.ts, [r.open, r.high, r.low, r.close, r.volume, r.quote_volume ?? NaN]);
            }
            for (const r of db.prepare('SELECT symbol, from_ts, to_ts FROM coverage').iterate()) {
                if (r.to_ts >= r.from_ts) writer.cover(r.symbol, r.from_ts, r.to_ts);
            }
            writer.close();
            const consumers = db.prepare('SELECT name, bars, seen_at FROM consumers').all();
            if (consumers.length) {
                this.ds.locked(() => {
                    const now = this.readConsumers();
                    for (const c of consumers) {
                        if (!now[c.name] || now[c.name].seenAt < c.seen_at) now[c.name] = { bars: c.bars, seenAt: c.seen_at };
                    }
                    this.writeConsumers(now);
                });
            }
        } finally {
            db.close();
        }
        for (const suffix of ['', '-wal', '-shm']) {
            try {
                renameSync(`${file}${suffix}`, `${file}${suffix}.migrated`);
            } catch {}
        }
    }

    coverage(symbol, at = null) {
        const list = this.ds.coverage(symbol);
        const pending = this.pending.get(symbol);
        if (pending) list.push(...pending.coverage);
        if (!list.length) return null;
        const merged = [];
        for (const [a, b] of list.slice().sort((x, y) => x[0] - y[0])) {
            const cur = merged[merged.length - 1];
            if (cur && a <= cur[1] + this.stepMs) cur[1] = Math.max(cur[1], b);
            else merged.push([a, b]);
        }
        let pick = merged[merged.length - 1];
        if (at != null) pick = merged.find(([a, b]) => a <= at && b >= at - this.stepMs) ?? pick;
        return { from_ts: pick[0], to_ts: pick[1] };
    }

    preload(fromTs, toTs) {
        this.preloaded = { from: fromTs, to: toTs, map: this.ds.read({ from: fromTs, to: toTs, fields: FIELDS }) };
    }

    release() {
        this.preloaded = null;
    }

    load(symbol, fromTs, toTs) {
        const pre = this.preloaded;
        const base = pre && fromTs >= pre.from && toTs <= pre.to
            ? pre.map.get(symbol) ?? null
            : this.ds.series(symbol, { from: fromTs, to: toTs, fields: FIELDS });
        const candles = candlesIn(base, fromTs, toTs);
        const pending = this.pending.get(symbol);
        if (!pending) return candles;
        const byTs = new Map(candles.map(c => [c.timestamp, c]));
        for (const c of pending.candles) if (c.timestamp >= fromTs && c.timestamp <= toTs) byTs.set(c.timestamp, c);
        return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
    }

    store(symbol, candles, { fromTs, toTs }) {
        let pending = this.pending.get(symbol);
        if (!pending) this.pending.set(symbol, pending = { candles: [], coverage: [] });
        pending.candles.push(...candles);
        if (toTs >= fromTs) pending.coverage.push([fromTs, toTs]);
    }

    flush() {
        if (!this.pending.size) return;
        const input = new Map();
        const coverage = new Map();
        for (const [symbol, { candles, coverage: list }] of this.pending) {
            if (candles.length) input.set(symbol, seriesOf(candles));
            if (list.length) coverage.set(symbol, list);
        }
        this.pending.clear();
        this.ds.write(input, { coverage });
        this.preloaded = null;
    }

    append(timestamp, candles) {
        this.flush();
        const input = new Map();
        const coverage = new Map();
        for (const { symbol, candle } of candles) {
            if (candle.timestamp !== timestamp) continue;
            input.set(symbol, seriesOf([candle]));
            coverage.set(symbol, [[timestamp, timestamp]]);
        }
        if (input.size) this.ds.write(input, { coverage });
    }

    readConsumers() {
        try {
            return JSON.parse(readFileSync(this.consumersFile, 'utf8'));
        } catch {
            return {};
        }
    }

    writeConsumers(consumers) {
        const tmp = `${this.consumersFile}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(consumers));
        renameSync(tmp, this.consumersFile);
    }

    registerConsumer(name, bars) {
        this.ds.locked(() => {
            const consumers = this.readConsumers();
            consumers[name] = { bars, seenAt: Date.now() };
            this.writeConsumers(consumers);
        });
    }

    prune(latestTs) {
        this.flush();
        const since = Date.now() - this.retentionMs;
        const bars = Math.max(0, ...Object.values(this.readConsumers()).filter(c => c.seenAt >= since).map(c => c.bars));
        if (!(bars > 0)) return 0;
        return this.ds.drop({ before: latestTs - bars * this.stepMs - 86400000 });
    }

    close() {
        this.flush();
    }
}

export class CandleCacheSource {
    constructor({ directory, archive = null, logger = null }) {
        this.directory = directory;
        this.archive = archive;
        this.logger = logger;
        this.datasets = new Map();
        this.retention = new Map();
        this.announced = new Set();
    }

    retained(interval) {
        if (this.retention.has(interval)) return this.retention.get(interval);
        const stats = this.database(interval).stats();
        const retained = { from: stats.first, symbols: new Set(stats.symbols.keys()) };
        this.retention.set(interval, retained);
        return retained;
    }

    database(interval) {
        if (this.datasets.has(interval)) return this.datasets.get(interval);
        const ds = openDataset(join(this.directory, interval));
        if (!ds.exists) throw new Error(`forward candle cache is unavailable for ${interval}`);
        this.datasets.set(interval, ds);
        return ds;
    }

    async *streamAllStocksInRange(interval, startDate, endDate, market = 'crypto', venue = 'binance') {
        const start = startDate.getTime();
        const end = endDate.getTime();
        const { from, symbols } = this.retained(interval);
        let cacheStart = start;
        if (this.archive && from != null && start < from) {
            const archiveEnd = Math.min(end, from - 1);
            let yielded = 0;
            try {
                const older = this.archive.streamAllStocksInRange(interval, startDate, new Date(archiveEnd), market, venue);
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
        for (const { view, i0, i1 } of this.database(interval).scan({ from: Math.max(start, cacheStart), to: end, fields: FIELDS })) {
            const sym = view.symbols();
            const c = view.cols;
            for (let i = i0; i < i1; i++) {
                const r = view.order[i];
                yield {
                    stockName: view.names[sym[r]],
                    candle: new Candle(c.open[r], c.high[r], c.low[r], c.close[r], c.volume[r], view.ts[r], c.quoteVolume?.[r] ?? NaN),
                };
            }
        }
    }

    async loadStockBeforeTimestamp(symbol, interval, date, count, market = 'crypto', venue = 'binance') {
        const { from } = this.retained(interval);
        if (this.archive && from != null && date.getTime() < from) {
            return this.archive.loadStockBeforeTimestamp(symbol, interval, date, count, market, venue);
        }
        const stock = new Stock(symbol, intervalMsMap[interval]);
        const series = this.database(interval).last(symbol, { at: date.getTime(), count, fields: FIELDS });
        if (series) {
            for (let i = series.ts.length - 1; i >= 0; i--) {
                stock.pushValues(series.open[i], series.high[i], series.low[i], series.close[i], series.volume[i], series.ts[i], series.quoteVolume[i]);
            }
        }
        stock.finish();
        return stock;
    }

    close() {
        this.datasets.clear();
    }
}
