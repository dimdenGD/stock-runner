// node scripts/massive_download.js [period] <startDate> <skip stored tickers>
// example: node scripts/massive_download.js 1d 2003-09-10 true

import 'dotenv/config';
import { candles } from "../src/data/datasets.js";
import { intervalMsMap } from "../src/backtest/consts.js";

const periodMap = {
    's': 'second',
    'm': 'minute',
    'h': 'hour',
    'd': 'day',
    'w': 'week',
    'M': 'month',
    'y': 'year',
    'q': 'quarter',
}
if(!process.argv[2]) {
    throw "Usage: node scripts/massive_download.js [period] <startDate> <skip>";
}
const rawPeriod = process.argv[2];
const multiplier = parseInt(rawPeriod);
const period = periodMap[rawPeriod.replace(multiplier+'', '')];

if(isNaN(multiplier) || !period) {
    throw "Invalid period. Example: node scripts/massive_download.js 1d";
}
const toAdd = rawPeriod === '1d' ? 60000*60*16 : intervalMsMap[rawPeriod];
if(!toAdd) {
    throw "Period must be one of 1d, 1h, 15m, 5m, 1m";
}

const MASSIVE_KEY = process.env.MASSIVE_KEY;
if(!MASSIVE_KEY) {
    throw "MASSIVE_KEY is not set. Please set it in the environment variables.";
}

const ds = candles('stocks', rawPeriod, 'binance', { create: true, fields: ['open', 'high', 'low', 'close', 'volume', 'trades'] });
const lastTimestamp = ds.lastTimestamp();
let startDate = new Date(process.argv[3] || '2003-09-10');
let skip = process.argv[4] === 'true';
if(lastTimestamp != null && !process.argv[3]) {
    startDate = new Date(lastTimestamp);
}

async function callMassive(path, params) {
    for(let param in params) {
        if(params[param] === undefined) {
            delete params[param];
        }
    }
    let results = [];
    const response = await fetch(`https://api.massive.com${path}?${new URLSearchParams(params).toString()}&apiKey=${MASSIVE_KEY}`);
    const data = await response.json();
    if(data.resultsCount === 0) {
        return [];
    }
    if(!Array.isArray(data.results)) {
        throw new Error('Invalid response: ' + JSON.stringify(data));
    }
    results.push(...data.results);
    let nextUrl = data.next_url;
    while(nextUrl) {
        const response = await fetch(nextUrl + '&apiKey=' + MASSIVE_KEY);
        const data = await response.json();
        if(data.resultsCount === 0) {
            break;
        }
        results.push(...data.results);
        nextUrl = data.next_url;
    }
    return results;
}

let tickerList = [];
{
    console.log('Downloading tickers...');
    const data = await callMassive('/v3/reference/tickers', {
        market: 'stocks',
        limit: 1000
    });
    tickerList = data.filter(t => t.primary_exchange === 'XNAS' || t.primary_exchange === 'XNYS').map(t => t.ticker);
}
console.log(`Got ${tickerList.length} tickers`);
if(skip) {
    const stored = new Set(ds.stats().symbols.keys());
    tickerList = tickerList.filter(t => !stored.has(t));
    console.log(`Remaining ${tickerList.length} tickers`);
}

const BATCH_SIZE = 50;
const endDate = new Date().toISOString().split('T')[0];
const startStr = startDate.toISOString().split('T')[0];

const writer = ds.bulk();
for (let i = 0; i < tickerList.length; i += BATCH_SIZE) {
    const batch = tickerList.slice(i, i + BATCH_SIZE);
    const range = `${i + 1}-${Math.min(i + BATCH_SIZE, tickerList.length)}/${tickerList.length}`;
    console.log(`Downloading batch ${range}: ${batch.join(', ')}`);
    const results = await Promise.all(batch.map(async (ticker) => {
        const url = `/v2/aggs/ticker/${ticker}/range/${multiplier}/${period}/${startStr}/${endDate}`;
        const rows = await callMassive(url, {
            adjusted: true,
            sort: 'asc',
            limit: 50000,
        });
        return { ticker, rows };
    }));
    for (const { ticker, rows } of results) {
        if (!rows.length) continue;
        writer.add(ticker, {
            ts: rows.map(r => r.t + toAdd),
            open: rows.map(r => r.o),
            high: rows.map(r => r.h),
            low: rows.map(r => r.l),
            close: rows.map(r => r.c),
            volume: rows.map(r => r.v),
            trades: rows.map(r => r.n),
        });
    }
}

writer.close();
console.log('Done');
