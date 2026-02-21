import Stock from './stock.js';
import { sql } from '../db.js';
import { allowedIntervals, intervalMsMap } from './consts.js';
import Candle from './candle.js';
import http from 'http';
import parse from 'csv-simple-parser';

/**
 * Async-generator that streams rows from QuestDB’s /exp CSV API.
 *
 * @param {string} query   A SQL query to run
 * @param {object} opts    Optional connection params
 * @param {string} opts.host    QuestDB host (default 'localhost')
 * @param {number} opts.port    QuestDB port (default 9000)
 * @param {object} opts.headers Any extra HTTP headers
 *
 * @yields {object} Each row as an object: { col1: val1, col2: val2, … }
 */
async function* fastFetch(
    query,
    { host = 'localhost', port = 9000, headers = {} } = {}
) {
    // 1) kick off the HTTP request
    const req = http.request({
        host,
        port,
        path: `/exp?query=${encodeURIComponent(query)}`,  // :contentReference[oaicite:0]{index=0}
        method: 'GET',
        headers: {
            Accept: 'text/csv',
            ...headers,
        },
    });

    const res = await new Promise((resolve, reject) => {
        req.on('error', reject);
        req.on('response', resolve);
        req.end();
    });

    if (res.statusCode !== 200) {
        throw new Error(`QuestDB error: ${res.statusCode}`);
    }

    let leftover = '';
    let i = 0;

    // 3) stream chunks, accumulate partial lines
    for await (const chunk of res) {
        const text = leftover + chunk.toString('utf8');
        const lines = text.split(/\r?\n/);
        leftover = lines.pop();  // last element is possibly an incomplete line

        if (lines.length) {
            // re-join complete lines into one CSV blob (you can also feed each line individually)
            const csvBatch = lines.join('\n');
            const parsed = parse(csvBatch);
            for(const row of parsed) {
                // skip header
                if(i === 0) {
                    i = 1;
                    continue;
                }
                if(row.length === 0) {
                    continue;
                }
                yield row;
            }
        }
    }

    // 4) flush any remaining line
    if (leftover) {
        const parsed = parse(leftover);
        for(const row of parsed) {
            if(row[0] === '') {
                continue;
            }
            yield row;
        }
    }
}

/**
 * Loads data for a stock from the database.
 * @param {string} stockName - The name of the stock to load.
 * @param {string} interval - The interval of the data to load.
 * @param {Date} startDate - The start date of the data to load.
 * @param {Date} endDate - The end date of the data to load.
 * @returns {Promise<Stock>} The loaded stock.
 * @throws {TypeError} If the interval is invalid or startDate and endDate are not instances of Date.
 */
export async function loadStockInRange(stockName, interval, startDate, endDate) {
    if (!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
    if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
        throw new TypeError('startDate and endDate must be instances of Date');
    }

    const intervalMs = intervalMsMap[interval];
    const stock = new Stock(stockName, intervalMs);
    const candles = fastFetch(`SELECT * FROM candles_${interval} WHERE ticker = '${stockName}' AND timestamp >= ${startDate.getTime() * 1000} AND timestamp < ${endDate.getTime() * 1000} ORDER BY timestamp ASC`);
    for await (const candle of candles) {
        stock.pushCandle(new Candle(+candle[1], +candle[2], +candle[3], +candle[4], +candle[5], new Date(candle[candle.length === 8 ? 7 : 6]).getTime()));
    }
    stock.finish();
    return stock;
}

/**
 * Loads data for a stock from the database.
 * @param {string} stockName - The name of the stock to load.
 * @param {string} interval - The interval of the data to load.
 * @param {Date} date - The date to load the data after.
 * @param {number} candlesCount - The number of candles to load.
 * @returns {Promise<Stock>} The loaded stock.
 * @throws {TypeError} If the interval is invalid or date is not an instance of Date.
 */
export async function loadStockAfterTimestamp(stockName, interval, date, candlesCount) {
    if (!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
    if (!(date instanceof Date)) {
        throw new TypeError('date must be an instance of Date');
    }
    if (typeof candlesCount !== 'number') {
        throw new TypeError('candlesCount must be a number');
    }
    if (candlesCount < 1) {
        throw new TypeError('candlesCount must be greater than 0');
    }

    const intervalMs = intervalMsMap[interval];
    const stock = new Stock(stockName, intervalMs);
    const candles = fastFetch(`SELECT * FROM candles_${interval} WHERE ticker = '${stockName}' AND timestamp >= ${date.getTime() * 1000} ORDER BY timestamp ASC LIMIT ${candlesCount}`);
    for await (const candle of candles) {
        stock.pushCandle(new Candle(+candle[1], +candle[2], +candle[3], +candle[4], +candle[5], new Date(candle[candle.length === 8 ? 7 : 6]).getTime()));
    }
    stock.finish();
    return stock;
}

/**
 * Loads data for a stock from the database.
 * @param {string} stockName - The name of the stock to load.
 * @param {string} interval - The interval of the data to load.
 * @param {Date} date - The date to load the data before.
 * @param {number} candlesCount - The number of candles to load.
 * @returns {Promise<Stock>} The loaded stock.
 * @throws {TypeError} If the interval is invalid or date is not an instance of Date.
 */
export async function loadStockBeforeTimestamp(stockName, interval, date, candlesCount) {
    if (!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
    if (!(date instanceof Date)) {
        throw new TypeError('date must be an instance of Date');
    }

    const intervalMs = intervalMsMap[interval];
    const stock = new Stock(stockName, intervalMs);
    const candles = fastFetch(`SELECT * FROM candles_${interval} WHERE ticker = '${stockName}' AND timestamp <= ${date.getTime() * 1000} ORDER BY timestamp DESC LIMIT ${candlesCount}`);
    for await (const candle of candles) {
        stock.pushCandle(new Candle(+candle[1], +candle[2], +candle[3], +candle[4], +candle[5], new Date(candle[candle.length === 8 ? 7 : 6]).getTime()));
    }
    stock.finish();
    return stock;
}


/**
 * Loads data for all stocks from the database.
 * @param {string} interval - The interval of the data to load.
 * @param {Date} startDate - The start date of the data to load.
 * @param {Date} endDate - The end date of the data to load.
 * @returns {Promise<Object<string, Stock>>} The loaded stocks.
 * @throws {TypeError} If the interval is invalid or startDate and endDate are not instances of Date.
 */
export async function loadAllStocksInRange(interval, startDate, endDate) {
    if (!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
    if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
        throw new TypeError('startDate and endDate must be instances of Date');
    }

    const intervalMs = intervalMsMap[interval];
    const stocks = {};

    const candles = fastFetch(`SELECT * FROM candles_${interval} WHERE timestamp >= ${startDate.getTime() * 1000} AND timestamp <= ${endDate.getTime() * 1000} ORDER BY timestamp ASC`);
    for await (const candle of candles) {
        const stockName = candle[0];
        if (!stocks[stockName]) {
            stocks[stockName] = new Stock(stockName, intervalMs);
        }
        stocks[stockName].pushCandle(new Candle(+candle[1], +candle[2], +candle[3], +candle[4], +candle[5], new Date(candle[candle.length === 8 ? 7 : 6]).getTime()));
    }

    for (const stock in stocks) {
        stocks[stock].finish();
    }
    return stocks;
}

/**
 * Gets the names of all stocks in the database.
 * @returns {Promise<string[]>} The names of all stocks.
 */
export async function getStockNames() {
    const stocks = await sql`SELECT DISTINCT ticker FROM candles_1d`;
    return stocks.map(stock => stock.ticker);
}