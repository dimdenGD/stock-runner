// node scripts/stooq_ingest.js <1d|1h|5m> [--full]

import fs from 'fs';
import path from 'path';
import { candles } from '../src/data/datasets.js';
import { parseCsvFiles } from '../src/data/ingest.js';

const type = process.argv[2];
const full = process.argv.includes('--full');
if (!['1d', '1h', '5m'].includes(type)) {
    console.error('Usage: node scripts/stooq_ingest.js <1d|1h|5m> [--full]');
    process.exit(1);
}

const offsets = new Map();
function offsetMs(timeZone, day) {
    const key = `${timeZone}|${day}`;
    if (!offsets.has(key)) {
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' });
        const name = fmt.formatToParts(new Date(`${day}T12:00:00Z`)).find(p => p.type === 'timeZoneName').value;
        const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
        offsets.set(key, m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60000 : 0);
    }
    return offsets.get(key);
}

function timestampOf(date, time) {
    const y = Math.floor(date / 10000);
    const mo = Math.floor(date / 100) % 100;
    const d = date % 100;
    const day = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (type === '1d') return Date.UTC(y, mo - 1, d, 16) - offsetMs('America/New_York', day);
    const hh = Math.floor(time / 10000);
    const mm = Math.floor(time / 100) % 100;
    const ss = time % 100;
    const wall = Date.UTC(y, mo - 1, d, hh, mm + (type === '5m' ? 5 : 0), ss);
    return wall - offsetMs('Europe/Warsaw', day);
}

function filesIn(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) filesIn(p, out);
        else if (entry.name.endsWith('.txt')) out.push({ file: p, ticker: entry.name.slice(0, -4).split('.').slice(0, -1).join('.').toUpperCase() });
    }
    return out;
}

const root = fs.existsSync(`data/stooq/${type}`) ? `data/stooq/${type}` : 'data/stooq';
const items = [];
for (const market of fs.readdirSync(root)) {
    if (market.endsWith(' stocks')) filesIn(path.join(root, market), items);
}

const ds = candles('stocks', type, 'binance', { create: true, fields: ['open', 'high', 'low', 'close', 'volume'] });
const since = full ? -Infinity : (ds.lastTimestamp() ?? -Infinity) + 86400000;
const until = Date.now();
if (since > -Infinity) console.log(`Last date in the store: ${new Date(since).toISOString().slice(0, 10)}`);

const started = Date.now();
const writer = ds.bulk();
let rows = 0;
let done = 0;
// <TICKER>,<PER>,<DATE>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>,<OPENINT>
for await (const { item, cols } of parseCsvFiles(items, { columns: [2, 3, 4, 5, 6, 7, 8] })) {
    const [date, time, open, high, low, close, volume] = cols;
    const keep = [];
    const ts = new Float64Array(date.length);
    for (let i = 0; i < date.length; i++) {
        ts[i] = timestampOf(date[i], time[i]);
        if (ts[i] >= since && ts[i] <= until) keep.push(i);
    }
    if (keep.length) {
        const pick = (a) => Float64Array.from(keep, i => a[i]);
        writer.add(item.ticker, { ts: pick(ts), open: pick(open), high: pick(high), low: pick(low), close: pick(close), volume: Float64Array.from(keep, i => Math.round(volume[i])) });
        rows += keep.length;
    }
    if (++done % 1000 === 0) console.log(`${done}/${items.length} files, ${rows.toLocaleString('en-US')} rows (${Math.round((Date.now() - started) / 1000)}s)`);
}
const result = writer.close();
console.log(`Ingested ${rows.toLocaleString('en-US')} rows from ${items.length} files into ${result.partitions} partitions`);
console.log('Done');
