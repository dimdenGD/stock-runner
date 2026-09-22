// node scripts/hyperliquid_download.js <interval> [--coins=BTC,ETH] [--hip3] [--no-funding] [--funding-from=YYYY-MM] [--weight=1000]
// example: node scripts/hyperliquid_download.js 4h

import fs from 'fs';
import path from 'path';

const INFO = 'https://api.hyperliquid.xyz/info';
const INTERVALS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
const CANDLE_CAP = 5000;
const FUNDING_PAGE = 500;

const interval = process.argv[2];
const opt = Object.fromEntries(process.argv.slice(3).filter(x => x.startsWith('--')).map(x => {
    const [k, v] = x.slice(2).split('=');
    return [k, v ?? true];
}));
if (!INTERVALS[interval]) {
    console.error(`Usage: node scripts/hyperliquid_download.js <${Object.keys(INTERVALS).join('|')}> [--coins=BTC,ETH] [--hip3] [--no-funding] [--funding-from=YYYY-MM] [--weight=1000]`);
    process.exit(1);
}
const stepMs = INTERVALS[interval];
const MAX_WEIGHT_PER_MIN = Number(opt.weight || 1000);
const root = 'data/hyperliquid';
const dirOf = (coin) => encodeURIComponent(coin);
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let used = 0, windowStart = Date.now(), chain = Promise.resolve();
function acquire(weight) {
    const run = async () => {
        if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); used = 0; }
        if (used + weight > MAX_WEIGHT_PER_MIN) {
            await sleep(60000 - (Date.now() - windowStart) + 50);
            windowStart = Date.now(); used = 0;
        }
        used += weight;
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
}

async function info(body, weight = 20) {
    await acquire(weight);
    for (let i = 0; ; i++) {
        try {
            const res = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
            if (!res.ok) throw new Error(`HTTP ${res.status} for ${JSON.stringify(body)}`);
            return await res.json();
        } catch (e) {
            if (i >= 5) throw e;
            await sleep(2000 * 2 ** i);
        }
    }
}

function readMonth(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function writeMonth(file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(rows));
    fs.renameSync(file + '.tmp', file);
}

function merge(dir, rows) {
    const byMonth = new Map();
    for (const r of rows) {
        const m = monthOf(r[0]);
        if (!byMonth.has(m)) byMonth.set(m, []);
        byMonth.get(m).push(r);
    }
    let added = 0;
    for (const [m, fresh] of byMonth) {
        const file = `${dir}/${m}.json`;
        const have = new Map(readMonth(file).map(r => [r[0], r]));
        for (const r of fresh) {
            if (!have.has(r[0])) added++;
            have.set(r[0], r);
        }
        writeMonth(file, [...have.values()].sort((a, b) => a[0] - b[0]));
    }
    return added;
}

function firstStored(dir) {
    if (!fs.existsSync(dir)) return null;
    for (const m of fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort()) {
        const rows = readMonth(`${dir}/${m}`);
        if (rows.length) return rows[0][0];
    }
    return null;
}

function lastStored(dir) {
    if (!fs.existsSync(dir)) return null;
    const months = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort();
    for (let i = months.length - 1; i >= 0; i--) {
        const rows = readMonth(`${dir}/${months[i]}`);
        if (rows.length) return rows.at(-1)[0];
    }
    return null;
}

async function coinsToFetch() {
    if (opt.coins) return String(opt.coins).split(',');
    const dexes = opt.hip3 ? (await info({ type: 'perpDexs' })).map(d => d?.name ?? '') : [''];
    const out = [];
    for (const dex of dexes) {
        const meta = await info(dex ? { type: 'meta', dex } : { type: 'meta' });
        for (const u of meta.universe || []) out.push(u.name);
    }
    return [...new Set(out)].sort();
}

async function candles(coin) {
    const dir = `${root}/klines/${interval}/${dirOf(coin)}`;
    const now = Date.now();
    const page = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: now - CANDLE_CAP * stepMs, endTime: now } }, 20 + Math.ceil(CANDLE_CAP / 60));
    const rows = (Array.isArray(page) ? page : [])
        .filter(b => +b.t + stepMs <= now)
        .map(b => [+b.t, +b.o, +b.h, +b.l, +b.c, +b.v, +b.n]);
    return rows.length ? merge(dir, rows) : 0;
}

async function funding(coin, fromMs) {
    const dir = `${root}/funding/${dirOf(coin)}`;
    let start = (lastStored(dir) ?? fromMs - 1) + 1;
    const end = Date.now();
    let added = 0;
    while (start < end) {
        const page = await info({ type: 'fundingHistory', coin, startTime: start, endTime: end }, 20 + Math.ceil(FUNDING_PAGE / 20));
        if (!Array.isArray(page) || !page.length) break;
        added += merge(dir, page.map(r => [+r.time, +r.fundingRate, +r.premium]));
        const last = +page.at(-1).time;
        if (page.length < FUNDING_PAGE || last < start) break;
        start = last + 1;
    }
    return added;
}

const coins = await coinsToFetch();
const fundingFrom = opt['funding-from'] ? Date.parse(`${opt['funding-from']}-01T00:00:00Z`) : null;
console.log(`${coins.length} coins, ${interval} candles${opt['no-funding'] ? '' : ` + hourly funding from ${fundingFrom ? monthOf(fundingFrom) : 'each coin\'s first candle'}`}`);
const started = Date.now();
for (const [i, coin] of coins.entries()) {
    try {
        const c = await candles(coin);
        const from = fundingFrom ?? firstStored(`${root}/klines/${interval}/${dirOf(coin)}`);
        const f = opt['no-funding'] || from == null ? 0 : await funding(coin, from);
        console.log(`${coin.padEnd(18)} ${i + 1}/${coins.length}  +${c.toLocaleString('en-US')} candles, +${f.toLocaleString('en-US')} funding  (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (e) {
        console.error(`${coin}: ${e.message}`);
    }
}
console.log('Done');
