// node scripts/binance_download.js <interval> [startMonth] [endMonth] [--no-daily] [--tail-only]
// example: node scripts/binance_download.js 15m 2023-09

import fs from 'fs';
import path from 'path';

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
const MONTHLY_RE = /^\d{4}-\d{2}\.zip$/;
const DAILY_RE = /^\d{4}-\d{2}-\d{2}\.zip$/;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextMonthStart = (month) => Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1);
const zipsMatching = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => re.test(f)).sort() : []);
const newestMonthIn = (dir) => zipsMatching(dir, MONTHLY_RE).map(f => f.slice(0, 7)).at(-1) || null;

function save(dest, buf) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.tmp', buf);
    fs.renameSync(dest + '.tmp', dest);
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

const klineRoot = `data/binance/klines/${interval}`;
let symbols;
if (tailOnly) {
    symbols = fs.existsSync(klineRoot) ? fs.readdirSync(klineRoot).filter(s => s.endsWith('USDT')).sort() : [];
    console.log(`Tail only: ${symbols.length} symbols already on disk`);
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
        [`data/futures/um/monthly/klines/${sym}/${interval}/`, `data/binance/klines/${interval}/${sym}`],
        [`data/futures/um/monthly/fundingRate/${sym}/`, `data/binance/funding/${sym}`],
    ];
    for (const [prefix, dir] of sources) {
        for (const key of await listS3(prefix)) {
            const m = key.match(/-(\d{4}-\d{2})\.zip$/);
            if (!m || m[1] < startMonth || m[1] > endMonth) continue;
            const dest = path.join(dir, `${m[1]}.zip`);
            if (!fs.existsSync(dest)) jobs.push({ url: `${ARCHIVE}/${key}`, dest });
        }
    }
    if (++listed % 50 === 0) console.log(`Listed ${listed}/${symbols.length} symbols, ${jobs.length} files to download`);
});
if (!tailOnly) console.log(`Downloading ${jobs.length} files...`);

let done = 0, bytes = 0;
await pool(jobs, CONCURRENCY, async ({ url, dest }) => {
    const buf = await fetchRetry(url);
    if (buf) {
        save(dest, buf);
        bytes += buf.length;
        const month = path.basename(dest, '.zip');
        const dir = path.dirname(dest);
        for (const f of zipsMatching(dir, DAILY_RE)) {
            if (f.startsWith(month)) fs.rmSync(path.join(dir, f), { force: true });
        }
    }
    if (++done % 200 === 0) console.log(`${done}/${jobs.length} (${(bytes / 1e9).toFixed(2)}GB)`);
});
console.log(`Monthly: ${done} files, ${(bytes / 1e9).toFixed(2)}GB`);

const lastDay = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
if (!noDaily && dayKey(lastDay).slice(0, 7) <= endMonth) {
    const activeMonth = symbols.reduce((best, sym) => {
        const m = newestMonthIn(`data/binance/klines/${interval}/${sym}`);
        return m && m > best ? m : best;
    }, '');

    if (!activeMonth) {
        console.log('No monthly archives on disk, skipping daily tail');
    } else {
        let days = 0, dayBytes = 0, checked = 0;
        await pool(symbols, CONCURRENCY, async (sym) => {
            const dir = `data/binance/klines/${interval}/${sym}`;
            const newest = newestMonthIn(dir);
            if (!newest || newest < activeMonth) return;
            const existing = zipsMatching(dir, DAILY_RE).map(f => f.slice(0, 10));
            let from = nextMonthStart(newest);
            if (existing.length) from = Math.max(from, Date.parse(existing.at(-1)) + DAY_MS);
            let misses = 0;
            for (let ts = from; ts <= lastDay; ts += DAY_MS) {
                const day = dayKey(ts);
                if (day.slice(0, 7) > endMonth) break;
                const dest = path.join(dir, `${day}.zip`);
                if (fs.existsSync(dest)) { misses = 0; continue; }
                const buf = await fetchRetry(`${ARCHIVE}/data/futures/um/daily/klines/${sym}/${interval}/${sym}-${interval}-${day}.zip`);
                if (!buf) { if (++misses >= 3) break; continue; }
                misses = 0;
                save(dest, buf);
                days++;
                dayBytes += buf.length;
            }
            if (++checked % 200 === 0) console.log(`Daily tail ${checked}/${symbols.length} symbols, ${days} files`);
        });
        console.log(`Daily tail through ${dayKey(lastDay)}: ${days} files, ${(dayBytes / 1e6).toFixed(1)}MB`);
    }
}
console.log('Done');
