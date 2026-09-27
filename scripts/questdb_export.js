// node scripts/questdb_export.js <table> [dataset] [--host=localhost:9000] [--from=YYYY-MM] [--to=YYYY-MM] [--partition=month] [--step=0]
// example: node scripts/questdb_export.js candles_15m

import { dataset } from '../src/data/datasets.js';
import { parseNumber } from '../src/data/csv.js';
import { intervalMsMap, partitionFor } from '../src/backtest/consts.js';

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? true];
}));
const [table, explicit] = positional;
const host = opt.host || `${process.env.QUESTDB_HOST || 'localhost'}:9000`;

function target(name) {
    let m;
    if ((m = name.match(/^crypto_candles_(\w+)$/))) return { name: `binance/${m[1]}`, step: intervalMsMap[m[1]], partition: partitionFor('crypto', m[1]) };
    if ((m = name.match(/^hl_candles_(\w+)$/))) return { name: `hyperliquid/${m[1]}`, step: intervalMsMap[m[1]], partition: partitionFor('crypto', m[1]) };
    if ((m = name.match(/^candles_(\w+)$/))) return { name: `stocks/${m[1]}`, step: intervalMsMap[m[1]], partition: partitionFor('stocks', m[1]) };
    if (name === 'crypto_funding') return { name: 'binance/funding', step: 0, partition: 'year' };
    if (name === 'hl_funding') return { name: 'hyperliquid/funding', step: 0, partition: 'year' };
    return null;
}

const guess = table ? target(table) : null;
if (!table || (!explicit && !guess)) {
    console.error('Usage: node scripts/questdb_export.js <table> [dataset] [--host=localhost:9000] [--from=YYYY-MM] [--to=YYYY-MM] [--partition=month] [--step=0]');
    process.exit(1);
}
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

async function exec(query) {
    const res = await fetch(`http://${host}/exec?query=${encodeURIComponent(query)}`);
    const body = await res.json();
    if (body.error) throw new Error(`${query}: ${body.error}`);
    return body;
}

const described = await exec(`show columns from ${table}`);
const at = Object.fromEntries(described.columns.map((c, i) => [c.name, i]));
const numeric = new Set(['DOUBLE', 'FLOAT', 'LONG', 'INT', 'SHORT', 'BYTE']);
const sourceColumns = described.dataset.filter(r => numeric.has(r[at.type]) && !r[at.designated]).map(r => r[at.column]);
const timestamp = described.dataset.find(r => r[at.designated])?.[at.column];
const symbol = described.dataset.find(r => r[at.type] === 'SYMBOL')?.[at.column];
if (!timestamp || !symbol) throw new Error(`${table} needs a designated timestamp and a SYMBOL column`);
const fields = sourceColumns.map(camel);

const name = explicit || guess.name;
const ds = dataset(name, {
    create: true,
    fields,
    step: Number(opt.step ?? guess?.step ?? 0),
    partition: opt.partition || guess?.partition || 'month',
});

const [range] = (await exec(`SELECT cast(min(${timestamp}) as long), cast(max(${timestamp}) as long) FROM ${table}`)).dataset;
if (range[0] == null) {
    console.log(`${table} is empty`);
    process.exit(0);
}
const month = (ms) => new Date(ms).toISOString().slice(0, 7);
const first = opt.from || month(range[0] / 1000);
const last = opt.to || month(range[1] / 1000);
const months = [];
for (let y = +first.slice(0, 4), m = +first.slice(5, 7); `${y}-${String(m).padStart(2, '0')}` <= last; m === 12 ? (y++, m = 1) : m++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
}

const writer = ds.bulk({ fields });
const started = Date.now();
let total = 0;
for (const m of months) {
    const [y, mo] = m.split('-').map(Number);
    const next = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
    const query = `SELECT ${symbol}, cast(${timestamp} as long), ${sourceColumns.join(', ')} FROM ${table} WHERE ${timestamp} >= '${m}-01' AND ${timestamp} < '${next}-01'`;
    const res = await fetch(`http://${host}/exp?query=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`${m}: HTTP ${res.status} ${await res.text()}`);
    let rows = 0;
    let header = true;
    let rest = Buffer.alloc(0);
    const values = new Array(fields.length);
    const consume = (buf, final) => {
        let pos = 0;
        for (;;) {
            let end = buf.indexOf(10, pos);
            if (end === -1) {
                if (!final || pos >= buf.length) break;
                end = buf.length;
            }
            let lineEnd = end;
            if (lineEnd > pos && buf[lineEnd - 1] === 13) lineEnd--;
            if (header) header = false;
            else if (lineEnd > pos) {
                let s = pos;
                let comma = buf.indexOf(44, s);
                const ticker = buf.toString('utf8', buf[s] === 34 ? s + 1 : s, buf[comma - 1] === 34 ? comma - 1 : comma);
                s = comma + 1;
                comma = buf.indexOf(44, s);
                const ts = parseNumber(buf, s, comma === -1 || comma > lineEnd ? lineEnd : comma) / 1000;
                for (let f = 0; f < fields.length; f++) {
                    s = comma + 1;
                    comma = buf.indexOf(44, s);
                    const e = comma === -1 || comma > lineEnd ? lineEnd : comma;
                    values[f] = s <= e ? parseNumber(buf, s, e) : NaN;
                }
                writer.push(ticker, ts, values);
                rows++;
            }
            pos = end + 1;
            if (pos > buf.length) break;
        }
        return buf.subarray(Math.min(pos, buf.length));
    };
    for await (const chunk of res.body) {
        rest = consume(rest.length ? Buffer.concat([rest, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
    }
    consume(rest, true);
    total += rows;
    console.log(`${m}  ${rows.toLocaleString('en-US')} rows  (${Math.round((Date.now() - started) / 1000)}s)`);
}
const result = writer.close();
console.log(`Exported ${total.toLocaleString('en-US')} rows from ${table} into ${name} (${result.partitions} partitions) in ${Math.round((Date.now() - started) / 1000)}s`);
console.log('Done');
