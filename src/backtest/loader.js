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
            for (const row of parsed) {
                // skip header
                if (i === 0) {
                    i = 1;
                    continue;
                }
                if (row.length === 0) {
                    continue;
                }
                yield row;
            }
        }
    }

    // 4) flush any remaining line
    if (leftover) {
        const parsed = parse(leftover);
        for (const row of parsed) {
            if (row[0] === '') {
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

function startDate(interval, date, candlesCount) {
    const m = interval.match(/^(\d+)([mhdwM])$/);
    if (!m) throw new Error('bad interval');
    const n = +m[1], unit = m[2];
    const t = (date instanceof Date) ? date.getTime() : +date;
    const fmt = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short'});
    const dayMs = 86400000, openMin = 9*60+30, closeMin = 16*60, sessionMin = closeMin - openMin;
    const parts = ms => Object.fromEntries(fmt.formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const minutesOfDay = p => (+p.hour)*60 + (+p.minute);
    const isTradingDay = p => !/Sat|Sun/.test(p.weekday);
    const openForLocalDate = ms => { const p = parts(ms); return ms - ((minutesOfDay(p) - openMin)*60000 + (+p.second)*1000); };
    const closeForLocalDate = ms => { const p = parts(ms); return ms - ((minutesOfDay(p) - closeMin)*60000 + (+p.second)*1000); };
    const prevTradingDayOpen = ms => {
      for (let i=0;i<14;i++){
        ms -= dayMs;
        const p = parts(ms);
        if (isTradingDay(p)) return openForLocalDate(ms);
      }
      throw new Error('no trading day found');
    };
    if (unit === 'd' || unit === 'w' || unit === 'M') {
      const lastCompleteDayOpen = (() => {
        let cur = t - 1;
        for (let i=0;i<14;i++){
          const closeMs = closeForLocalDate(cur);
          const p = parts(cur);
          if (isTradingDay(p) && closeMs < t) return openForLocalDate(cur);
          cur -= dayMs;
        }
        throw new Error('no completed trading day');
      })();
      if (unit === 'M') {
        let need = n * candlesCount;
        let curOpen = lastCompleteDayOpen;
        while (need > 0) {
          const p = parts(curOpen);
          const year = +p.year, month = +p.month;
          // find first trading day of this month
          let cursor = curOpen;
          while (true) {
            const q = parts(cursor);
            if (+q.month !== month || +q.year !== year) break;
            if (isTradingDay(q)) var firstOpen = openForLocalDate(cursor);
            cursor -= dayMs;
          }
          curOpen = firstOpen;
          need--;
          // move to previous completed trading day before the last day of previous month
          curOpen = prevTradingDayOpen(curOpen - 1);
        }
        return new Date(curOpen);
      }
      let totalDays = candlesCount * (unit === 'd' ? n : n * 5);
      let cur = lastCompleteDayOpen;
      while (totalDays > 1) { cur = prevTradingDayOpen(cur - 1); totalDays--; }
      return new Date(cur);
    }
  
    const intervalMin = unit === 'h' ? n * 60 : n;
    const stepMs = intervalMin * 60000;
    const candlesPerSession = Math.floor(sessionMin / intervalMin);
  
    const lastSessionInfo = (() => {
      const p = parts(t - 1);
      const localMinFromOpen = minutesOfDay(p) - openMin;
      if (!isTradingDay(p) || localMinFromOpen <= 0) return {available:0, sessionOpen: prevTradingDayOpen(t - 1)};
      const indexByEnd = Math.floor((localMinFromOpen - 1) / intervalMin);
      const lastIndex = Math.min(indexByEnd, candlesPerSession - 1);
      const available = lastIndex >= 0 ? lastIndex + 1 : 0;
      const sessionOpen = openForLocalDate(t - 1);
      return {available, lastIndex, sessionOpen};
    })();
  
    let need = candlesCount;
    if (need <= lastSessionInfo.available) {
      const startIndex = lastSessionInfo.lastIndex - (need - 1);
      return new Date(lastSessionInfo.sessionOpen + startIndex * stepMs);
    }
    need -= lastSessionInfo.available;
    let fullSkip = Math.floor((need - 1) / candlesPerSession); // how many full sessions to step back beyond the one that will supply partial
    let remainder = need - fullSkip * candlesPerSession;
    // move to the session that will provide the earliest candle
    let targetOpen = lastSessionInfo.available ? prevTradingDayOpen(lastSessionInfo.sessionOpen - 1) : prevTradingDayOpen(t - 1);
    for (let i=0;i<fullSkip;i++) targetOpen = prevTradingDayOpen(targetOpen - 1);
    if (remainder === 0) return new Date(targetOpen); // exact fit: start at open of that session
    const startIndex = candlesPerSession - remainder;
    return new Date(targetOpen + startIndex * stepMs);
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
    let aboveTimestamp = startDate(interval, date, candlesCount).getTime();
    const q = `SELECT * FROM candles_${interval} WHERE ticker = '${stockName}' AND timestamp <= ${date.getTime() * 1000} AND timestamp >= ${aboveTimestamp * 1000} ORDER BY timestamp DESC LIMIT ${candlesCount}`;
    const candles = fastFetch(q);
    const start = Date.now();
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