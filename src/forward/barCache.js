import { mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { openDataset } from '../data/store.js';
import { etTime, nyDate, sessionOf } from './nyTime.js';

const DAY = 86400000;
const DELAY = 15 * 60000;
const FIELDS = ['open', 'high', 'low', 'close', 'volume', 'vwap', 'trades'];

const parseTs = (v, endOfDay) => {
    const s = String(v);
    return Date.parse(s.length === 10 ? `${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}Z` : s);
};
const shift = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayStart = (day) => etTime(day, '00:00');
const dayEnd = (day) => etTime(shift(day, 1), '00:00') - 1;

function seriesOf(bars) {
    const n = bars.length;
    const out = { ts: new Float64Array(n) };
    for (const f of FIELDS) out[f] = new Float64Array(n);
    bars.forEach((b, i) => {
        out.ts[i] = b.t;
        out.open[i] = b.o;
        out.high[i] = b.h;
        out.low[i] = b.l;
        out.close[i] = b.c;
        out.volume[i] = b.v;
        out.vwap[i] = b.vw ?? NaN;
        out.trades[i] = b.n ?? NaN;
    });
    return out;
}

function barsOf(s) {
    const out = new Array(s.ts.length);
    for (let i = 0; i < s.ts.length; i++) {
        out[i] = { t: s.ts[i], o: s.open[i], h: s.high[i], l: s.low[i], c: s.close[i], v: s.volume[i], vw: s.vwap[i], n: s.trades[i] };
    }
    return out;
}

export default function withBarCache(broker, { dir, horizon = null, memoAssets = false } = {}) {
    const root = dir ?? join('output', 'forward', 'cache', `alpaca-${broker.feed}`);
    const proxy = Object.create(broker);
    let calendar = null;
    const datasets = new Map();
    const adjusted = new Map();
    let assets = null;
    proxy.cacheStats = { cachedDays: 0, fetchedDays: 0 };

    proxy.getCalendar = async (from, to) => {
        if (!calendar || from < calendar.from || to > calendar.to) {
            const lo = shift(calendar && calendar.from < from ? calendar.from : from, -370);
            const hi = shift(calendar && calendar.to > to ? calendar.to : to, 40);
            calendar = { from: lo, to: hi, entries: await broker.getCalendar(lo, hi) };
        }
        return calendar.entries.filter(e => e.date >= from && e.date <= to);
    };
    const sessions = async (from, to) => (await proxy.getCalendar(from, to)).map(sessionOf);
    if (memoAssets) proxy.getAssets = async () => (assets ||= await broker.getAssets());

    function migrate(folder, ds) {
        let files;
        try {
            files = readdirSync(folder).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
        } catch {
            return;
        }
        if (!files.length) return;
        const bars = new Map();
        const coverage = new Map();
        for (const f of files) {
            const j = JSON.parse(gunzipSync(readFileSync(join(folder, f))).toString('utf8'));
            for (const s of j.symbols) {
                if (!coverage.has(s)) coverage.set(s, []);
                coverage.get(s).push([dayStart(j.day), dayEnd(j.day)]);
            }
            for (const [s, rows] of Object.entries(j.bars)) {
                if (!bars.has(s)) bars.set(s, []);
                for (const r of rows) bars.get(s).push({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], vw: r[6], n: r[7] });
            }
        }
        ds.write(new Map([...bars].map(([s, rows]) => [s, seriesOf(rows)])), { coverage });
        const legacy = join(folder, 'legacy-json');
        mkdirSync(legacy, { recursive: true });
        for (const f of files) {
            try {
                renameSync(join(folder, f), join(legacy, f));
            } catch {}
        }
    }

    function dataset(tf) {
        let ds = datasets.get(tf);
        if (!ds) {
            const folder = join(root, tf);
            ds = openDataset(folder, { create: true, fields: FIELDS, step: 0, partition: tf === '1Day' ? 'year' : 'day' });
            migrate(folder, ds);
            datasets.set(tf, ds);
        }
        return ds;
    }

    const covers = (map, s, day) => (map.get(s) ?? []).some(([a, b]) => a <= dayStart(day) && b >= dayEnd(day));

    function store(tf, from, to, symbols, rowsOf) {
        const input = new Map();
        const coverage = new Map();
        for (const s of symbols) {
            const rows = rowsOf(s);
            if (rows.length) input.set(s, seriesOf(rows));
            coverage.set(s, [[dayStart(from), dayEnd(to)]]);
        }
        dataset(tf).write(input, { coverage });
    }

    async function fill(tf, days, symbols, today) {
        proxy.cacheStats.fetchedDays += days.length;
        if (tf === '1Day') {
            const yesterday = nyDate(Date.now() - DAY);
            let end = days.at(-1).day;
            if (horizon && horizon > end) end = horizon < today ? horizon : yesterday;
            const span = (await sessions(days[0].day, end)).filter(d => d.day < today);
            const got = await broker.bars(symbols, { timeframe: '1Day', start: days[0].day, end: `${end}T23:59:59Z`, adjustment: 'raw' });
            if (!span.length) return;
            const inSpan = new Set(span.map(d => d.day));
            store(tf, span[0].day, span.at(-1).day, symbols, s => (got.get(s) || []).filter(b => inSpan.has(nyDate(b.t))));
            return;
        }
        for (const d of days) {
            const got = await broker.bars(symbols, {
                timeframe: tf, start: new Date(d.open).toISOString(), end: new Date(d.close).toISOString(), adjustment: 'raw',
            });
            store(tf, d.day, d.day, symbols, s => (got.get(s) || []).filter(b => b.t >= d.open && b.t < d.close));
        }
    }

    async function adjustedBars(symbols, opts) {
        const key = `${opts.timeframe}|${opts.adjustment}`;
        if (!adjusted.has(key)) adjusted.set(key, new Map());
        const cache = adjusted.get(key);
        const lo = parseTs(opts.start, false), hi = parseTs(opts.end, true);
        const need = symbols.filter(s => { const c = cache.get(s); return !c || c.from > lo || c.to < hi; });
        if (need.length) {
            const to = Math.min(Math.max(hi, horizon ? parseTs(horizon, true) : hi), Date.now() - DELAY);
            const got = await broker.bars(need, { ...opts, start: new Date(lo).toISOString(), end: new Date(to).toISOString() });
            for (const s of need) cache.set(s, { from: lo, to, rows: got.get(s) || [] });
        }
        const out = new Map();
        for (const s of symbols) {
            const rows = (cache.get(s)?.rows || []).filter(b => b.t >= lo && b.t <= hi);
            if (rows.length) out.set(s, rows);
        }
        return out;
    }

    proxy.bars = async (symbols, opts = {}) => {
        if ((opts.adjustment || 'raw') !== 'raw') return adjustedBars(symbols, opts);
        const tf = opts.timeframe;
        const lo = parseTs(opts.start, false), hi = parseTs(opts.end, true);
        const today = nyDate();
        const days = await sessions(nyDate(lo), nyDate(hi));
        const past = days.filter(d => d.day < today);
        const out = new Map();
        const push = (s, b) => {
            if (b.t < lo || b.t > hi) return;
            let a = out.get(s);
            if (!a) out.set(s, a = []);
            a.push(b);
        };
        if (past.length) {
            const ds = dataset(tf);
            const from = dayStart(past[0].day);
            const to = dayEnd(past.at(-1).day);
            const coverage = ds.coverageMap({ symbols, from, to });
            const missing = new Set();
            const stale = [];
            for (const d of past) {
                let need = false;
                for (const s of symbols) if (!covers(coverage, s, d.day)) { missing.add(s); need = true; }
                if (need) stale.push(d);
            }
            proxy.cacheStats.cachedDays += past.length - stale.length;
            if (stale.length) await fill(tf, stale, [...missing], today);

            const dayIndex = new Map(past.map((d, i) => [d.day, i]));
            const found = ds.read({ symbols, from: Math.max(lo, from), to: Math.min(hi, to), fields: FIELDS });
            const rows = [];
            symbols.forEach((s, k) => {
                const series = found.get(s);
                if (!series) return;
                for (const b of barsOf(series)) {
                    const i = dayIndex.get(nyDate(b.t));
                    if (i !== undefined) rows.push([i, k, b]);
                }
            });
            rows.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
            for (const [, k, b] of rows) push(symbols[k], b);
        }
        if (days.some(d => d.day >= today)) {
            const start = Math.max(lo, etTime(today, '00:00'));
            const got = await broker.bars(symbols, { ...opts, start: new Date(start).toISOString() });
            for (const [s, rows] of got) for (const b of rows) push(s, b);
        }
        return out;
    };

    return proxy;
}
