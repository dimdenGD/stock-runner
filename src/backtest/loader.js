import Stock from './stock.js';
import { eachDayOfInterval, format, addDays, eachMinuteOfInterval, addMinutes } from 'date-fns';
import { sql } from '../db.js';
import Candle from './candle.js';

/**
 * Loads daily data for a stock from the database.
 * @param {string} stockName - The name of the stock to load.
 * @param {Date} startDate - The start date of the data to load.
 * @param {Date} endDate - The end date of the data to load.
 * @returns {Promise<Stock>} The loaded stock.
 */
export async function loadDaily(stockName, startDate, endDate) {
    const stock = new Stock(stockName, 1000*60*60*24);
    const start = new Date();
    const candles = await sql`SELECT * FROM candles_daily WHERE ticker = ${stockName} AND timestamp >= ${startDate} AND timestamp < ${endDate}`;
    for(const candle of candles) {
        stock.pushCandle(new Candle(candle.open, candle.high, candle.low, candle.close, +candle.volume, +candle.transactions, candle.timestamp));
    }
    stock.finish();
    const end = new Date();
    console.log(`Loaded ${stock.size} ${stockName} daily candles in ${end - start}ms`);
    return stock;
}

/**
 * Loads minute data for a stock from the database.
 * @param {string} stockName - The name of the stock to load.
 * @param {Date} startDate - The start date of the data to load.
 * @param {Date} endDate - The end date of the data to load.
 * @returns {Promise<Stock>} The loaded stock.
 */
export async function loadMinute(stockName, startDate, endDate) {
    const stock = new Stock(stockName, 1000*60);
    const start = new Date();
    const candles = await sql`SELECT * FROM candles_minute WHERE ticker = ${stockName} AND timestamp >= ${startDate} AND timestamp < ${endDate}`;
    for(const candle of candles) {
        stock.pushCandle(new Candle(candle.open, candle.high, candle.low, candle.close, +candle.volume, +candle.transactions, candle.timestamp));
    }
    stock.finish();
    const end = new Date();
    console.log(`Loaded ${stock.size} ${stockName} minute candles in ${end - start}ms`);
    return stock;
}