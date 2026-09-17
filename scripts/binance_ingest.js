// node scripts/binance_ingest.js <interval>
// example: node scripts/binance_ingest.js 15m

import fs from 'fs';
import { sender, sql, createTables } from '../src/db.js';
import { unzipSingle } from '../src/lib/zip.js';
import { intervalMsMap } from '../src/backtest/consts.js';

await createTables();

const interval = process.argv[2];
const klineDir = `data/binance/klines/${interval}`;
if (!intervalMsMap[interval] || !fs.existsSync(klineDir)) {
    console.error(`Usage: node scripts/binance_ingest.js <interval>  (needs ${klineDir}, see binance_download.js)`);
    process.exit(1);
}
const stepMs = intervalMsMap[interval];
const toMs = (x) => (x > 1e14 ? Math.floor(x / 1000) : x);
const isDataLine = (line) => line.charCodeAt(0) >= 48 && line.charCodeAt(0) <= 57; // skips headers
const yyyymm = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const lastMonthOf = async (table) => Object.fromEntries(
    (await sql.unsafe(`SELECT ticker, timestamp FROM ${table} LATEST ON timestamp PARTITION BY ticker`))
        .map(r => [r.ticker, yyyymm(new Date(r.timestamp).getTime())])
);

function csvLines(zipPath) {
    return unzipSingle(fs.readFileSync(zipPath)).toString('utf8').split('\n').filter(isDataLine);
}
const zipsIn = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.zip')).sort() : [];

const lastCandleMonth = await lastMonthOf(`crypto_candles_${interval}`);
const lastFundingMonth = await lastMonthOf('crypto_funding');
console.log(`Resuming from last month: ${Object.keys(lastCandleMonth).length} tickers with candles, ${Object.keys(lastFundingMonth).length} with funding`);

const symbols = fs.readdirSync(klineDir).sort();
let candles = 0, funding = 0;
const started = Date.now();
for (const [i, sym] of symbols.entries()) {
    const fromCandle = lastCandleMonth[sym];
    for (const f of zipsIn(`${klineDir}/${sym}`)) {
        if (fromCandle && f.slice(0, 7) < fromCandle) continue;
        // open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore
        for (const line of csvLines(`${klineDir}/${sym}/${f}`)) {
            const c = line.split(',');
            await sender
                .table(`crypto_candles_${interval}`)
                .symbol('ticker', sym)
                .floatColumn('open', +c[1])
                .floatColumn('high', +c[2])
                .floatColumn('low', +c[3])
                .floatColumn('close', +c[4])
                .floatColumn('volume', +c[5])
                .floatColumn('quote_volume', +c[7])
                .at(toMs(+c[0]) + stepMs, 'ms');
            candles++;
        }
    }
    const fromFunding = lastFundingMonth[sym];
    const fundingDir = `data/binance/funding/${sym}`;
    for (const f of zipsIn(fundingDir)) {
        if (fromFunding && f.slice(0, 7) < fromFunding) continue;
        // calc_time,funding_interval_hours,last_funding_rate
        for (const line of csvLines(`${fundingDir}/${f}`)) {
            const c = line.split(',');
            await sender
                .table('crypto_funding')
                .symbol('ticker', sym)
                .floatColumn('rate', +c[2])
                .intColumn('interval_hours', parseInt(c[1]))
                .at(toMs(+c[0]), 'ms');
            funding++;
        }
    }
    console.log(`${sym.padEnd(18)} ${i + 1}/${symbols.length}  ${candles.toLocaleString('en-US')} candles, ${funding.toLocaleString('en-US')} funding rows  (${Math.round((Date.now() - started) / 1000)}s)`);
}
await sender.flush();

const tables = [`crypto_candles_${interval}`, 'crypto_funding'];
while (true) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const status = await sql`SELECT name, "writerTxn", "sequencerTxn", suspended FROM wal_tables() WHERE name IN ${sql(tables)}`;
    const suspended = status.find(s => s.suspended);
    if (suspended) throw new Error(`QuestDB suspended writes to ${suspended.name}; see its log`);
    const pending = status.filter(s => Number(s.writerTxn) < Number(s.sequencerTxn));
    if (!pending.length) break;
    console.log(`Waiting for QuestDB to apply rows: ${pending.map(s => `${s.name} ${s.writerTxn}/${s.sequencerTxn}`).join(', ')}`);
}

console.log('Done');
await sender.close();
await sql.end();
