import Stock from './stock.js';
import { sql } from '../db.js';
import { allowedIntervals, intervalMsMap } from './consts.js';
import Candle from './candle.js';

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
    if(!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
    if(!(startDate instanceof Date) || !(endDate instanceof Date)) {
        throw new TypeError('startDate and endDate must be instances of Date');
    }

    const intervalMs = intervalMsMap[interval];
    const stock = new Stock(stockName, intervalMs);
    const candles = await sql`SELECT * FROM ${sql(`candles_${interval}`)} WHERE ticker = ${stockName} AND timestamp >= ${startDate} AND timestamp < ${endDate} ORDER BY timestamp ASC`;
    for(const candle of candles) {
        stock.pushCandle(new Candle(candle.open, candle.high, candle.low, candle.close, +candle.volume, +candle.transactions, candle.timestamp));
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
    if(!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
    if(!(date instanceof Date)) {
        throw new TypeError('date must be an instance of Date');
    }
    if(typeof candlesCount !== 'number') {
        throw new TypeError('candlesCount must be a number');
    }
    if(candlesCount < 1) {
        throw new TypeError('candlesCount must be greater than 0');
    }

    const intervalMs = intervalMsMap[interval];
    const stock = new Stock(stockName, intervalMs);
    const candles = await sql`SELECT * FROM ${sql(`candles_${interval}`)} WHERE ticker = ${stockName} AND timestamp >= ${date} ORDER BY timestamp ASC LIMIT ${candlesCount}`;
    for(const candle of candles) {
        stock.pushCandle(new Candle(candle.open, candle.high, candle.low, candle.close, +candle.volume, +candle.transactions, candle.timestamp));
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
    if(!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
    if(!(date instanceof Date)) {
        throw new TypeError('date must be an instance of Date');
    }

    const intervalMs = intervalMsMap[interval];
    const stock = new Stock(stockName, intervalMs);
    const candles = await sql`SELECT * FROM ${sql(`candles_${interval}`)} WHERE ticker = ${stockName} AND timestamp < ${date} ORDER BY timestamp DESC LIMIT ${candlesCount}`;
    for(const candle of candles) {
        stock.pushCandle(new Candle(candle.open, candle.high, candle.low, candle.close, +candle.volume, +candle.transactions, candle.timestamp));
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
    if(!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
    if(!(startDate instanceof Date) || !(endDate instanceof Date)) {
        throw new TypeError('startDate and endDate must be instances of Date');
    }

    const intervalMs = intervalMsMap[interval];
    const candles = await sql`SELECT * FROM ${sql(`candles_${interval}`)} WHERE timestamp >= ${startDate} AND timestamp < ${endDate} ORDER BY timestamp ASC`;
    const stocks = {};
    for(let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        if(!stocks[candle.ticker]) {
            stocks[candle.ticker] = new Stock(candle.ticker, intervalMs);
        }
        stocks[candle.ticker].pushCandle(new Candle(candle.open, candle.high, candle.low, candle.close, +candle.volume, +candle.transactions, candle.timestamp));
    }
    for(const stock in stocks) {
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