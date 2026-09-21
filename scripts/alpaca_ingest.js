import "dotenv/config";
import { Sender } from "@questdb/nodejs-client";
import { sql, createTables } from "../src/db.js";

await createTables();
import fs from 'fs';
import readline from 'readline';

const type = process.argv[2];

if (!['1d', '1h', '15m', '5m', '1m'].includes(type)) {
    console.error('Usage: node alpaca_ingest.js <1d|1h|15m|5m|1m>');
    process.exit(1);
}

const DAY = 60000*60*24;
const toAdd = {
    '1d': 60000*60*16,
    '1h': 60000*60,
    '15m': 60000*15,
    '5m': 60000*5,
    '1m': 60000,
}
const bucketMs = {
    '1d': DAY*366,
    '1h': DAY*31,
    '15m': DAY*7,
    '5m': DAY*7,
    '1m': DAY,
}

const USERNAME = process.env.QUESTDB_USERNAME || 'admin';
const PASSWORD = process.env.QUESTDB_PASSWORD || 'quest';
const HOST = process.env.QUESTDB_HOST || 'localhost';
const sender = Sender.fromConfig(`http::addr=${HOST}:9000;username=${USERNAME};password=${PASSWORD};auto_flush_rows=100000;auto_flush_interval=0;`);

const srcDir = `data/alpaca/${type}`;
const bucketDir = `data/alpaca/_buckets_${type}`;
fs.rmSync(bucketDir, { recursive: true, force: true });
fs.mkdirSync(bucketDir, { recursive: true });

const pending = {};
let pendingLines = 0;
function flushPending() {
    for (const key in pending) {
        fs.appendFileSync(`${bucketDir}/${key}.csv`, pending[key].join('\n') + '\n');
        delete pending[key];
    }
    pendingLines = 0;
}

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.csv'));
for (let i = 0; i < files.length; i++) {
    const rl = readline.createInterface({ input: fs.createReadStream(`${srcDir}/${files[i]}`, { encoding: 'utf-8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        const arr = line.split(',');
        if (arr[0] === 'ticker' || arr.length !== 8) continue;
        const key = String(Math.floor(+arr[6] / bucketMs[type])).padStart(8, '0');
        (pending[key] ??= []).push(line);
        if (++pendingLines >= 1_000_000) flushPending();
    }
    if ((i + 1) % 1000 === 0) console.log(`Bucketed ${i + 1}/${files.length} files`);
}
flushPending();

const buckets = fs.readdirSync(bucketDir).sort();
let total = 0;
for (let b = 0; b < buckets.length; b++) {
    const rows = fs.readFileSync(`${bucketDir}/${buckets[b]}`, 'utf-8').split('\n').filter(Boolean).map(line => line.split(','));
    rows.sort((x, y) => x[6] - y[6]);
    for (const arr of rows) {
        await sender
            .table(`candles_${type}`)
            .symbol('ticker', arr[0])
            .floatColumn('open', +arr[2])
            .floatColumn('high', +arr[4])
            .floatColumn('low', +arr[5])
            .floatColumn('close', +arr[3])
            .intColumn('volume', parseInt(arr[1]))
            .at(+arr[6] + toAdd[type], 'ms');
    }
    await sender.flush();
    total += rows.length;
    fs.rmSync(`${bucketDir}/${buckets[b]}`);
    console.log(`Ingested bucket ${b + 1}/${buckets.length}, ${total} rows`);
}
fs.rmSync(bucketDir, { recursive: true, force: true });

console.log('Done');
await sender.close();
await sql.end();
