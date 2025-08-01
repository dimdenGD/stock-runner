import Stock from './stock.js';
import CSV from 'fast-csv';
import { eachDayOfInterval, format } from 'date-fns';
import fs from 'fs';
import Candle from './candle.js';

const MAX_CONCURRENT_REQUESTS = 10;

/**
 * Loads daily data for a stock from the data directory.
 * @param {string} stockName - The name of the stock to load.
 * @param {Date} startDate - The start date of the data to load.
 * @param {Date} endDate - The end date of the data to load.
 * @returns {Promise<Stock>} The loaded stock.
 */
export async function loadDaily(stockName, startDate, endDate) {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const stock = new Stock(stockName);
    const start = new Date();

    let temporaryData = [];
    let promises = [];

    for (const i in days) {
        const day = days[i];
        if(!fs.existsSync(`data/daily/${format(day, 'yyyy-MM-dd')}.csv`)) {
            continue;
        }
        const date = format(day, 'yyyy-MM-dd');
        const filename = `data/daily/${date}.csv`;
        const stream = fs.createReadStream(filename).pipe(CSV.parse({ headers: true, quote: null }));
        const promise = Promise.withResolvers();
        promises.push(promise);

        stream.on('data', (row) => {
            if(row.ticker !== stockName) {
                return;
            }
            const candle = new Candle(row.open, row.high, row.low, row.close, row.volume, row.window_start / 1000000, row.transactions);
            temporaryData.push(candle);
        });

        stream.on('end', () => {
            promise.resolve();
        });

        if(promises.length >= MAX_CONCURRENT_REQUESTS) {
            await Promise.all(promises.map(p => p.promise));
            temporaryData.sort((a, b) => a.timestamp - b.timestamp);
            for(const candle of temporaryData) {
                stock.pushCandle(candle);
            }
            temporaryData = [];
            promises = [];
            console.log(`Loaded ${(((+i + 1) / days.length) * 100).toFixed(2)}% of ${stockName} data`);
        }
    }
    const end = new Date();
    console.log(`Loaded ${stockName} data in ${end - start}ms`);
    return stock;
}

export async function loadAllDaily(startDate, endDate) {
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const start = new Date();
    const stocks = {};

    for (const i in days) {
        const day = days[i];
        if(!fs.existsSync(`data/daily/${format(day, 'yyyy-MM-dd')}.csv`)) {
            continue;
        }
        const date = format(day, 'yyyy-MM-dd');
        const filename = `data/daily/${date}.csv`;
        const stream = fs.createReadStream(filename).pipe(CSV.parse({ headers: true, quote: null }));
        const promise = Promise.withResolvers();

        stream.on('data', (row) => {
            if(!stocks[row.ticker]) {
                stocks[row.ticker] = new Stock(row.ticker);
            }
            const candle = new Candle(row.open, row.high, row.low, row.close, row.volume, row.window_start / 1000000, row.transactions);
            stocks[row.ticker].pushCandle(candle);
        });

        stream.on('end', () => {
            promise.resolve();
        });

        await promise.promise;
        console.log(`Loaded ${(((+i + 1) / days.length) * 100).toFixed(2)}% of data`);
    }
    const end = new Date();
    console.log(`Loaded all data in ${end - start}ms`);
    return stocks;
}