// node scripts/massive_download.js [period] <startDate> <skip downloaded tickers>
// example: node scripts/massive_download.js 1d 2003-09-10 true

import 'dotenv/config';
import fs from 'fs';
import { writeFile } from 'fs/promises';
import { sender, sql } from "../src/db.js";

if(!fs.existsSync('data')) {
    fs.mkdirSync('data');
}
if(!fs.existsSync('data/massive')) {
    fs.mkdirSync('data/massive');
}

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

if(!fs.existsSync(`data/massive/${rawPeriod}`)) {
    fs.mkdirSync(`data/massive/${rawPeriod}`);
}

const MASSIVE_KEY = process.env.MASSIVE_KEY;
if(!MASSIVE_KEY) {
    throw "MASSIVE_KEY is not set. Please set it in the environment variables.";
}

const lastDate = await sql`SELECT timestamp FROM ${sql(`candles_${rawPeriod}`)} ORDER BY timestamp DESC LIMIT 1`;
let startDate = new Date(process.argv[3] || '2003-09-10');
let skip = process.argv[4] === 'true';
if(lastDate.length > 0 && !process.argv[3]) {
    startDate = new Date(lastDate[0].timestamp);
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
    const files = fs.readdirSync(`data/massive/${rawPeriod}`).map(f => f.split('.').slice(0, -1).join('.'));
    tickerList = tickerList.filter(t => !files.includes(t));
    console.log(`Remaining ${tickerList.length} tickers`);
}

const BATCH_SIZE = 10;
const endDate = new Date().toISOString().split('T')[0];
const startStr = startDate.toISOString().split('T')[0];

for (let i = 0; i < tickerList.length; i += BATCH_SIZE) {
    const batch = tickerList.slice(i, i + BATCH_SIZE);
    const range = `${i + 1}-${Math.min(i + BATCH_SIZE, tickerList.length)}/${tickerList.length}`;
    console.log(`Downloading batch ${range}: ${batch.join(', ')}`);
    const results = await Promise.all(batch.map(async (ticker) => {
        const url = `/v2/aggs/ticker/${ticker}/range/${multiplier}/${period}/${startStr}/${endDate}`;
        const data = await callMassive(url, {
            adjusted: true,
            sort: 'asc',
            limit: 50000,
        });
        let output = '';
        /* ticker,volume,open,close,high,low,window_start,transactions*/
        for (const row of data) {
            output += `${ticker},${row.v},${row.o},${row.c},${row.h},${row.l},${row.t},${row.n}\n`;
        }
        return { ticker, output };
    }));
    await Promise.all(results.map(({ ticker, output }) =>
        writeFile(`data/massive/${rawPeriod}/${ticker}.csv`, output)
    ));
}

console.log('Done');
await sender.close();
await sql.end();