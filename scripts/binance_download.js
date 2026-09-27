// node scripts/binance_download.js <interval> [startMonth] [endMonth] [--no-daily] [--tail-only]
// example: node scripts/binance_download.js 15m 2023-09

import { candles, funding, CANDLE_FIELDS } from '../src/data/datasets.js';
import { parseCsvFiles } from '../src/data/ingest.js';
import { parseCsv } from '../src/data/csv.js';
import { unzipSingle } from '../src/lib/zip.js';
import { intervalMsMap } from '../src/backtest/consts.js';

const S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';
const ARCHIVE = 'https://data.binance.vision';
const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const CONCURRENCY = 16;

const interval = process.argv[2];
if (!INTERVALS.includes(interval)) {
    console.error(`Usage: node scripts/binance_download.js <${INTERVALS.join('|')}> [startMonth YYYY-MM] [endMonth YYYY-MM]`);
    process.exit(1);
}
const months = process.argv.slice(3).filter(x => !x.startsWith('--'));
const startMonth = months[0] || '2019-09';
const endMonth = months[1] || '9999-12';
const noDaily = process.argv.includes('--no-daily');
const tailOnly = process.argv.includes('--tail-only');

const DAY_MS = 86400000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthStart = (month) => Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1, 1);
const nextMonthStart = (month) => Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1);
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const toMs = (x) => (x > 1e14 ? Math.floor(x / 1000) : x);
const stepMs = intervalMsMap[interval];
// open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore
const KLINE_COLUMNS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10];
// calc_time,funding_interval_hours,last_funding_rate
const FUNDING_COLUMNS = [0, 1, 2];

const klineStore = candles('crypto', interval, 'binance', { create: true, fields: [...CANDLE_FIELDS, 'trades', 'takerBuyVolume', 'takerBuyQuoteVolume'] });
const fundingStore = funding('binance', { create: true });
let klineCoverage = klineStore.coverageMap();
const fundingCoverage = fundingStore.coverageMap();
const covers = (map, sym, from, to) => (map.get(sym) ?? []).some(([a, b]) => a <= from && b >= to);
const storedMonth = (sym, month) => covers(klineCoverage, sym, monthStart(month) + stepMs, nextMonthStart(month));
const storedFunding = (sym, month) => covers(fundingCoverage, sym, monthStart(month), nextMonthStart(month) - 1);
const storedDay = (sym, ts) => covers(klineCoverage, sym, ts + stepMs, ts + DAY_MS);

function newestMonth(sym) {
    let m = monthOf(Date.now());
    for (let i = 0; i < 120; i++) {
        if (storedMonth(sym, m)) return m;
        m = monthOf(monthStart(m) - 1);
    }
    return null;
}

function klineSeries([t, open, high, low, close, volume, quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume]) {
    for (let i = 0; i < t.length; i++) t[i] = toMs(t[i]) + stepMs;
    return { ts: t, open, high, low, close, volume, quoteVolume, trades, takerBuyVolume, takerBuyQuoteVolume };
}

function fundingSeries([t, intervalHours, rate]) {
    for (let i = 0; i < t.length; i++) t[i] = toMs(t[i]);
    return { ts: t, rate, intervalHours };
}

async function fetchRetry(url, tries = 5) {
    for (let i = 0; ; i++) {
        try {
            const res = await fetch(url);
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) {
            if (i >= tries - 1) throw e;
            await new Promise(r => setTimeout(r, 1000 * 2 ** i));
        }
    }
}

async function listS3(prefix, folders = false) {
    const out = [];
    let token = null;
    do {
        const url = `${S3}?list-type=2&prefix=${encodeURIComponent(prefix)}` +
            (folders ? '&delimiter=%2F' : '') +
            (token ? `&continuation-token=${encodeURIComponent(token)}` : '');
        const xml = (await fetchRetry(url)).toString('utf8');
        const tag = folders ? 'Prefix' : 'Key';
        for (const m of xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))) {
            if (m[1] !== prefix) out.push(m[1]);
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
            ? xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)[1]
            : null;
    } while (token);
    return out;
}

async function pool(items, limit, fn) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) await fn(items[next++]);
    }));
}

let symbols;
if (tailOnly) {
    symbols = [...new Set([...klineCoverage.keys(), ...klineStore.stats().symbols.keys()])].filter(s => s.endsWith('USDT')).sort();
    console.log(`Tail only: ${symbols.length} symbols in the store`);
} else {
    console.log('Listing symbols...');
    symbols = (await listS3('data/futures/um/monthly/klines/', true))
        .map(p => p.split('/').at(-2))
        .filter(s => s.endsWith('USDT'))
        .sort();
    console.log(`Got ${symbols.length} USDT perpetuals (including delisted)`);
}

const jobs = [];
let listed = 0;
if (!tailOnly) await pool(symbols, CONCURRENCY, async (sym) => {
    const sources = [
        [`data/futures/um/monthly/klines/${sym}/${interval}/`, 'klines', storedMonth],
        [`data/futures/um/monthly/fundingRate/${sym}/`, 'funding', storedFunding],
    ];
    for (const [prefix, kind, stored] of sources) {
        for (const key of await listS3(prefix)) {
            const m = key.match(/-(\d{4}-\d{2})\.zip$/);
            if (!m || m[1] < startMonth || m[1] > endMonth || stored(sym, m[1])) continue;
            jobs.push({ url: `${ARCHIVE}/${key}`, sym, kind, month: m[1], columns: kind === 'klines' ? KLINE_COLUMNS : FUNDING_COLUMNS });
        }
    }
    if (++listed % 50 === 0) console.log(`Listed ${listed}/${symbols.length} symbols, ${jobs.length} files to download`);
});
if (!tailOnly) console.log(`Downloading ${jobs.length} files...`);

let done = 0, bytes = 0, candleRows = 0;
const klineWriter = klineStore.bulk();
const fundingWriter = fundingStore.bulk();
jobs.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
const load = async (job) => {
    const buf = await fetchRetry(job.url);
    if (buf) bytes += buf.length;
    return buf;
};
for await (const { item, cols } of parseCsvFiles(jobs, { load, window: 2 * CONCURRENCY })) {
    if (cols) {
        const start = monthStart(item.month);
        const end = nextMonthStart(item.month);
        if (item.kind === 'klines') {
            const series = klineSeries(cols);
            klineWriter.add(item.sym, series);
            klineWriter.cover(item.sym, start + stepMs, end);
            candleRows += series.ts.length;
        } else {
            fundingWriter.add(item.sym, fundingSeries(cols));
            fundingWriter.cover(item.sym, start, end - 1);
        }
    }
    if (++done % 200 === 0) console.log(`${done}/${jobs.length} (${(bytes / 1e9).toFixed(2)}GB)`);
}
klineWriter.close();
fundingWriter.close();
console.log(`Monthly: ${done} files, ${(bytes / 1e9).toFixed(2)}GB, ${candleRows.toLocaleString('en-US')} candles`);

const lastDay = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
if (!noDaily && dayKey(lastDay).slice(0, 7) <= endMonth) {
    klineCoverage = klineStore.coverageMap();
    const newest = new Map(symbols.map(sym => [sym, newestMonth(sym)]));
    const activeMonth = [...newest.values()].reduce((best, m) => (m && m > best ? m : best), '');

    if (!activeMonth) {
        console.log('No monthly data in the store, skipping daily tail');
    } else {
        const writer = klineStore.bulk();
        let days = 0, dayBytes = 0, checked = 0;
        await pool(symbols, CONCURRENCY, async (sym) => {
            const latest = newest.get(sym);
            if (!latest || latest < activeMonth) return;
            let misses = 0;
            for (let ts = nextMonthStart(latest); ts <= lastDay; ts += DAY_MS) {
                const day = dayKey(ts);
                if (day.slice(0, 7) > endMonth) break;
                if (storedDay(sym, ts)) { misses = 0; continue; }
                const buf = await fetchRetry(`${ARCHIVE}/data/futures/um/daily/klines/${sym}/${interval}/${sym}-${interval}-${day}.zip`);
                if (!buf) { if (++misses >= 3) break; continue; }
                misses = 0;
                writer.add(sym, klineSeries(parseCsv(unzipSingle(buf), KLINE_COLUMNS)));
                writer.cover(sym, ts + stepMs, ts + DAY_MS);
                days++;
                dayBytes += buf.length;
            }
            if (++checked % 200 === 0) console.log(`Daily tail ${checked}/${symbols.length} symbols, ${days} files`);
        });
        writer.close();
        console.log(`Daily tail through ${dayKey(lastDay)}: ${days} files, ${(dayBytes / 1e6).toFixed(1)}MB`);
    }
}
console.log('Done');
