// node scripts/hyperliquid_download.js <interval> [--coins=BTC,ETH] [--hip3] [--no-funding] [--funding-from=YYYY-MM] [--weight=1000]
// example: node scripts/hyperliquid_download.js 4h

import { candles, funding, CANDLE_FIELDS } from '../src/data/datasets.js';

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
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const candleStore = candles('crypto', interval, 'hyperliquid', { create: true, fields: [...CANDLE_FIELDS, 'trades'] });
const fundingStore = funding('hyperliquid', { create: true });
const storedCandles = candleStore.stats().symbols;
const storedFunding = fundingStore.stats().symbols;
const candleWriter = candleStore.bulk();
const fundingWriter = fundingStore.bulk();

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

async function fetchCandles(coin) {
    const now = Date.now();
    const page = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: now - CANDLE_CAP * stepMs, endTime: now } }, 20 + Math.ceil(CANDLE_CAP / 60));
    const rows = (Array.isArray(page) ? page : []).filter(b => +b.t + stepMs <= now);
    if (!rows.length) return { added: 0, first: null };
    const n = rows.length;
    const s = { ts: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n), quoteVolume: new Float64Array(n), trades: new Float64Array(n) };
    rows.forEach((b, i) => {
        const [o, h, l, c, v] = [+b.o, +b.h, +b.l, +b.c, +b.v];
        s.ts[i] = +b.t + stepMs;
        s.open[i] = o;
        s.high[i] = h;
        s.low[i] = l;
        s.close[i] = c;
        s.volume[i] = v;
        s.quoteVolume[i] = v * (o + h + l + c) / 4;
        s.trades[i] = b.n == null ? NaN : +b.n;
    });
    candleWriter.add(coin, s);
    const last = storedCandles.get(coin)?.last ?? -Infinity;
    return { added: s.ts.filter(t => t > last).length, first: s.ts[0] - stepMs };
}

async function fetchFunding(coin, fromMs) {
    let start = (storedFunding.get(coin)?.last ?? fromMs - 1) + 1;
    const end = Date.now();
    let added = 0;
    while (start < end) {
        const page = await info({ type: 'fundingHistory', coin, startTime: start, endTime: end }, 20 + Math.ceil(FUNDING_PAGE / 20));
        if (!Array.isArray(page) || !page.length) break;
        fundingWriter.add(coin, {
            ts: page.map(r => +r.time),
            rate: page.map(r => +r.fundingRate),
            intervalHours: page.map(() => 1),
            premium: page.map(r => +r.premium),
        });
        added += page.length;
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
        const c = await fetchCandles(coin);
        const stored = storedCandles.get(coin)?.first;
        const firstCandle = stored != null ? Math.min(stored - stepMs, c.first ?? Infinity) : c.first;
        const from = fundingFrom ?? firstCandle;
        const f = opt['no-funding'] || from == null ? 0 : await fetchFunding(coin, from);
        console.log(`${coin.padEnd(18)} ${i + 1}/${coins.length}  +${c.added.toLocaleString('en-US')} candles, +${f.toLocaleString('en-US')} funding  (${Math.round((Date.now() - started) / 1000)}s)`);
    } catch (e) {
        console.error(`${coin}: ${e.message}`);
    }
}
candleWriter.close();
fundingWriter.close();
console.log('Done');
