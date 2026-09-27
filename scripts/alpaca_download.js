// node scripts/alpaca_download.js [period] <startDate> <skip stored tickers> <adjustment>
// example: node scripts/alpaca_download.js 15m 2023-01-01 true all

import 'dotenv/config';
import { candles } from "../src/data/datasets.js";

const timeframes = {
    '1d': '1Day',
    '1h': '1Hour',
    '15m': '15Min',
    '5m': '5Min',
    '1m': '1Min',
};
const toAdd = {
    '1d': 60000*60*16,
    '1h': 60000*60,
    '15m': 60000*15,
    '5m': 60000*5,
    '1m': 60000,
};
const rawPeriod = process.argv[2];
const timeframe = timeframes[rawPeriod];
if(!timeframe) {
    throw "Usage: node scripts/alpaca_download.js <1d|1h|15m|5m|1m> <startDate> <skip> <adjustment>";
}

const KEY = process.env.APCA_API_KEY_ID;
const SECRET = process.env.APCA_API_SECRET_KEY;
if(!KEY || !SECRET) {
    throw "APCA_API_KEY_ID and APCA_API_SECRET_KEY must be set in the environment variables.";
}
const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const TRADING_URL = process.env.ALPACA_TRADING_URL || 'https://paper-api.alpaca.markets';
const FEED = process.env.ALPACA_FEED || 'sip';
const RPM = +(process.env.ALPACA_RPM || 200);
const EXCHANGES = ['NASDAQ', 'NYSE', 'ARCA', 'AMEX', 'BATS'];

const ds = candles('stocks', rawPeriod, 'binance', { create: true, fields: ['open', 'high', 'low', 'close', 'volume', 'trades'] });
const lastTimestamp = ds.lastTimestamp();
let startDate = new Date(process.argv[3] || '2016-01-01');
const skip = process.argv[4] === 'true';
const adjustment = process.argv[5] || 'all';
if(lastTimestamp != null && !process.argv[3]) {
    startDate = new Date(lastTimestamp);
}

let nextSlot = 0;
async function callAlpaca(base, path, params) {
    const url = new URL(path, base);
    for(const param in params) {
        if(params[param] !== undefined) {
            url.searchParams.set(param, params[param]);
        }
    }
    for(let attempt = 0; ; attempt++) {
        const now = Date.now();
        const at = Math.max(now, nextSlot);
        nextSlot = at + 60000 / RPM;
        if(at > now) {
            await new Promise(resolve => setTimeout(resolve, at - now));
        }
        let response;
        try {
            response = await fetch(url, {
                headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET },
            });
        } catch(e) {
            if(attempt >= 5) throw e;
            await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
            continue;
        }
        if(response.status === 429 || response.status >= 500) {
            if(attempt >= 5) throw new Error(`Alpaca HTTP ${response.status}: ${await response.text()}`);
            await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** attempt));
            continue;
        }
        if(!response.ok) {
            const error = new Error(`Alpaca HTTP ${response.status}: ${await response.text()}`);
            error.invalidSymbol = error.message.match(/invalid symbol: ([^"]+)/)?.[1];
            throw error;
        }
        return response.json();
    }
}

let tickerList = [];
{
    console.log('Downloading tickers...');
    for(const status of ['active', 'inactive']) {
        const assets = await callAlpaca(TRADING_URL, '/v2/assets', { asset_class: 'us_equity', status });
        tickerList.push(...assets.filter(a => EXCHANGES.includes(a.exchange) && /^[A-Z][A-Z.]{0,9}$/.test(a.symbol)).map(a => a.symbol));
    }
    tickerList = [...new Set(tickerList)].sort();
}
console.log(`Got ${tickerList.length} tickers`);
if(skip) {
    const stored = new Set(ds.stats().symbols.keys());
    tickerList = tickerList.filter(t => !stored.has(t));
    console.log(`Remaining ${tickerList.length} tickers`);
}

const BATCH_SIZE = rawPeriod === '1d' ? 200 : 25;
const endDate = new Date(Date.now() - 16 * 60 * 1000).toISOString();
const startStr = startDate.toISOString();

async function downloadBatch(batch) {
    const outputs = Object.fromEntries(batch.map(t => [t, []]));
    let pageToken;
    do {
        const data = await callAlpaca(DATA_URL, '/v2/stocks/bars', {
            symbols: batch.join(','),
            timeframe,
            start: startStr,
            end: endDate,
            adjustment,
            feed: FEED,
            sort: 'asc',
            limit: 10000,
            page_token: pageToken,
        });
        for(const ticker in data.bars || {}) {
            outputs[ticker]?.push(...data.bars[ticker]);
        }
        pageToken = data.next_page_token;
    } while(pageToken);
    return outputs;
}

const writer = ds.bulk();
for(let i = 0; i < tickerList.length; i += BATCH_SIZE) {
    let batch = tickerList.slice(i, i + BATCH_SIZE);
    const range = `${i + 1}-${Math.min(i + BATCH_SIZE, tickerList.length)}/${tickerList.length}`;
    console.log(`Downloading batch ${range}: ${batch.join(', ')}`);
    let outputs;
    while(!outputs) {
        try {
            outputs = await downloadBatch(batch);
        } catch(e) {
            if(!e.invalidSymbol || !batch.includes(e.invalidSymbol)) throw e;
            console.log(`Skipping invalid symbol ${e.invalidSymbol}`);
            batch = batch.filter(t => t !== e.invalidSymbol);
        }
    }
    for(const ticker of batch) {
        const rows = outputs[ticker];
        if(!rows.length) continue;
        writer.add(ticker, {
            ts: rows.map(r => Date.parse(r.t) + toAdd[rawPeriod]),
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
