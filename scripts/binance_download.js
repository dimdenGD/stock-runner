// node scripts/binance_download.js <interval> [startMonth] [endMonth]
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
const startMonth = process.argv[3] || '2019-09';
const endMonth = process.argv[4] || '9999-12';

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

console.log('Listing symbols...');
const symbols = (await listS3('data/futures/um/monthly/klines/', true))
    .map(p => p.split('/').at(-2))
    .filter(s => s.endsWith('USDT'))
    .sort();
console.log(`Got ${symbols.length} USDT perpetuals (including delisted)`);

const jobs = [];
let listed = 0;
await pool(symbols, CONCURRENCY, async (sym) => {
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
console.log(`Downloading ${jobs.length} files...`);

let done = 0, bytes = 0;
await pool(jobs, CONCURRENCY, async ({ url, dest }) => {
    const buf = await fetchRetry(url);
    if (buf) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest + '.tmp', buf);
        fs.renameSync(dest + '.tmp', dest);
        bytes += buf.length;
    }
    if (++done % 200 === 0) console.log(`${done}/${jobs.length} (${(bytes / 1e9).toFixed(2)}GB)`);
});
console.log(`Done: ${done} files, ${(bytes / 1e9).toFixed(2)}GB`);
