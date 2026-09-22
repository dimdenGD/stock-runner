// node scripts/hyperliquid_ingest.js <interval>
// example: node scripts/hyperliquid_ingest.js 4h

import fs from 'fs';
import { sender, sql, createTables } from '../src/db.js';
import { intervalMsMap, venueTables } from '../src/backtest/consts.js';

await createTables();

const interval = process.argv[2];
const klineDir = `data/hyperliquid/klines/${interval}`;
if (!intervalMsMap[interval] || !fs.existsSync(klineDir)) {
    console.error(`Usage: node scripts/hyperliquid_ingest.js <interval>  (needs ${klineDir}, see hyperliquid_download.js)`);
    process.exit(1);
}
const { candles: candleBase, funding: fundingTable } = venueTables('hyperliquid');
const candleTable = `${candleBase}_${interval}`;
const stepMs = intervalMsMap[interval];
const monthEnd = (f) => Date.UTC(+f.slice(0, 4), +f.slice(5, 7), 1);
const lastTimestampOf = async (table) => Object.fromEntries(
    (await sql.unsafe(`SELECT ticker, cast(timestamp as long) AS ts FROM ${table} LATEST ON timestamp PARTITION BY ticker`))
        .map(r => [r.ticker, Math.round(Number(r.ts) / 1000)])
);
const monthsIn = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.json$/.test(f)).sort() : [];
const rowsOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const lastCandleTs = await lastTimestampOf(candleTable);
const lastFundingTs = await lastTimestampOf(fundingTable);
console.log(`Resuming: ${Object.keys(lastCandleTs).length} tickers with candles, ${Object.keys(lastFundingTs).length} with funding`);

const dirs = fs.readdirSync(klineDir).sort();
let candles = 0, funding = 0;
const started = Date.now();
for (const [i, dir] of dirs.entries()) {
    const ticker = decodeURIComponent(dir);
    const wasCandles = candles;
    const wasFunding = funding;
    const fromCandle = lastCandleTs[ticker];
    for (const f of monthsIn(`${klineDir}/${dir}`)) {
        if (fromCandle && monthEnd(f) + stepMs <= fromCandle) continue;
        for (const [t, o, h, l, c, v] of rowsOf(`${klineDir}/${dir}/${f}`)) {
            const closeTs = t + stepMs;
            if (fromCandle && closeTs <= fromCandle) continue;
            await sender
                .table(candleTable)
                .symbol('ticker', ticker)
                .floatColumn('open', o)
                .floatColumn('high', h)
                .floatColumn('low', l)
                .floatColumn('close', c)
                .floatColumn('volume', v)
                .floatColumn('quote_volume', v * (o + h + l + c) / 4)
                .at(closeTs, 'ms');
            candles++;
        }
    }
    const fromFunding = lastFundingTs[ticker];
    const fundingDir = `data/hyperliquid/funding/${dir}`;
    for (const f of monthsIn(fundingDir)) {
        if (fromFunding && monthEnd(f) <= fromFunding) continue;
        for (const [t, rate] of rowsOf(`${fundingDir}/${f}`)) {
            if (fromFunding && t <= fromFunding) continue;
            await sender
                .table(fundingTable)
                .symbol('ticker', ticker)
                .floatColumn('rate', rate)
                .intColumn('interval_hours', 1)
                .at(t, 'ms');
            funding++;
        }
    }
    const added = candles - wasCandles;
    const addedFunding = funding - wasFunding;
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (added || addedFunding) {
        console.log(`${ticker.padEnd(18)} ${i + 1}/${dirs.length}  +${added.toLocaleString('en-US')} candles, +${addedFunding.toLocaleString('en-US')} funding  (${elapsed}s)`);
    } else if ((i + 1) % 200 === 0 || i + 1 === dirs.length) {
        console.log(`${(`${i + 1}/${dirs.length}`).padEnd(18)} nothing new so far; ${candles.toLocaleString('en-US')} candles, ${funding.toLocaleString('en-US')} funding rows  (${elapsed}s)`);
    }
}
console.log(`Ingested ${candles.toLocaleString('en-US')} candles and ${funding.toLocaleString('en-US')} funding rows from ${dirs.length} coins`);
await sender.flush();

const tables = [candleTable, fundingTable];
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
