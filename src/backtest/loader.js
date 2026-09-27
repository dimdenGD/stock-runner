import Stock from './stock.js';
import Candle from './candle.js';
import { allowedIntervals, candleDataset, intervalMsMap } from './consts.js';
import { candles, funding } from '../data/datasets.js';

const fieldsFor = (market) => (market === 'crypto'
    ? ['open', 'high', 'low', 'close', 'volume', 'quoteVolume']
    : ['open', 'high', 'low', 'close', 'volume']);

function checkInterval(interval) {
    if (!allowedIntervals.includes(interval)) {
        throw new TypeError(`Invalid interval: ${interval}`);
    }
}

function checkDates(...dates) {
    if (!dates.every(d => d instanceof Date)) {
        throw new TypeError('dates must be instances of Date');
    }
}

function column(series, field) {
    return series[field] ?? new Float64Array(series.ts.length).fill(NaN);
}

function quoteVolumes(series, market) {
    const { close, volume } = series;
    if (market === 'crypto' && series.quoteVolume) return series.quoteVolume;
    const out = new Float64Array(series.ts.length);
    for (let i = 0; i < out.length; i++) out[i] = volume[i] * close[i];
    return out;
}

function stockFrom(name, interval, series, market, reverse = false) {
    const stock = new Stock(name, intervalMsMap[interval]);
    if (!series || !series.ts.length) {
        stock.finish();
        return stock;
    }
    const n = series.ts.length;
    const cols = {
        opens: column(series, 'open'),
        highs: column(series, 'high'),
        lows: column(series, 'low'),
        closes: column(series, 'close'),
        volumes: column(series, 'volume'),
        timestamps: series.ts,
        quoteVolumes: quoteVolumes(series, market),
    };
    for (const [key, values] of Object.entries(cols)) {
        const buffer = Float64Array.from(values);
        if (reverse) buffer.reverse();
        stock[key].buffer = buffer;
        stock[key].length = n;
    }
    stock.size = n;
    stock.finish();
    return stock;
}

function dataset(interval, market, venue) {
    return candles(market, interval, venue);
}

/**
 * Loads data for a stock from the store.
 * @param {string} stockName - The name of the stock to load.
 * @param {string} interval - The interval of the data to load.
 * @param {Date} startDate - The start date of the data to load.
 * @param {Date} endDate - The end date of the data to load.
 * @param {string} market - The market to load the data from.
 * @returns {Promise<Stock>} The loaded stock.
 * @throws {TypeError} If the interval is invalid or startDate and endDate are not instances of Date.
 */
export async function loadStockInRange(stockName, interval, startDate, endDate, market = 'stocks', venue = 'binance') {
    checkInterval(interval);
    checkDates(startDate, endDate);
    const series = dataset(interval, market, venue).series(stockName, {
        from: startDate.getTime(), to: endDate.getTime() - 1, fields: fieldsFor(market),
    });
    return stockFrom(stockName, interval, series, market);
}

/**
 * Loads data for a stock from the store.
 * @param {string} stockName - The name of the stock to load.
 * @param {string} interval - The interval of the data to load.
 * @param {Date} date - The date to load the data after.
 * @param {number} candlesCount - The number of candles to load.
 * @param {string} market - The market to load the data from.
 * @returns {Promise<Stock>} The loaded stock.
 * @throws {TypeError} If the interval is invalid or date is not an instance of Date.
 */
export async function loadStockAfterTimestamp(stockName, interval, date, candlesCount, market = 'stocks', venue = 'binance') {
    checkInterval(interval);
    checkDates(date);
    if (typeof candlesCount !== 'number') {
        throw new TypeError('candlesCount must be a number');
    }
    if (candlesCount < 1) {
        throw new TypeError('candlesCount must be greater than 0');
    }
    const series = dataset(interval, market, venue).first(stockName, {
        from: date.getTime(), count: candlesCount, fields: fieldsFor(market),
    });
    return stockFrom(stockName, interval, series, market);
}

function startDate(interval, date, candlesCount, market = 'stocks') {
    if (market === 'crypto') {
        const t = (date instanceof Date) ? date.getTime() : +date;
        return new Date(t - (candlesCount + 1) * intervalMsMap[interval]);
    }
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
          let cursor = curOpen;
          while (true) {
            const q = parts(cursor);
            if (+q.month !== month || +q.year !== year) break;
            if (isTradingDay(q)) var firstOpen = openForLocalDate(cursor);
            cursor -= dayMs;
          }
          curOpen = firstOpen;
          need--;
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
    let fullSkip = Math.floor((need - 1) / candlesPerSession);
    let remainder = need - fullSkip * candlesPerSession;
    let targetOpen = lastSessionInfo.available ? prevTradingDayOpen(lastSessionInfo.sessionOpen - 1) : prevTradingDayOpen(t - 1);
    for (let i=0;i<fullSkip;i++) targetOpen = prevTradingDayOpen(targetOpen - 1);
    if (remainder === 0) return new Date(targetOpen);
    const startIndex = candlesPerSession - remainder;
    return new Date(targetOpen + startIndex * stepMs);
}

/**
 * Loads data for a stock from the store.
 * @param {string} stockName - The name of the stock to load.
 * @param {string} interval - The interval of the data to load.
 * @param {Date} date - The date to load the data before.
 * @param {number} candlesCount - The number of candles to load.
 * @returns {Promise<Stock>} The loaded stock.
 * @throws {TypeError} If the interval is invalid or date is not an instance of Date.
 */
export async function loadStockBeforeTimestamp(stockName, interval, date, candlesCount, market = 'stocks', venue = 'binance') {
    checkInterval(interval);
    checkDates(date);
    const series = dataset(interval, market, venue).last(stockName, {
        at: date.getTime(),
        from: startDate(interval, date, candlesCount, market).getTime(),
        count: candlesCount,
        fields: fieldsFor(market),
    });
    return stockFrom(stockName, interval, series, market, true);
}

/**
 * Loads data for all stocks from the store.
 * @param {string} interval - The interval of the data to load.
 * @param {Date} startDate - The start date of the data to load.
 * @param {Date} endDate - The end date of the data to load.
 * @returns {Promise<Object<string, Stock>>} The loaded stocks.
 * @throws {TypeError} If the interval is invalid or startDate and endDate are not instances of Date.
 */
export async function loadAllStocksInRange(interval, startDate, endDate, market = 'stocks', venue = 'binance') {
    checkInterval(interval);
    checkDates(startDate, endDate);
    const out = {};
    const all = dataset(interval, market, venue).read({ from: startDate.getTime(), to: endDate.getTime(), fields: fieldsFor(market) });
    for (const [name, series] of all) out[name] = stockFrom(name, interval, series, market);
    return out;
}

export function* candleGroups(interval, startDate, endDate, market = 'stocks', venue = 'binance') {
    checkInterval(interval);
    checkDates(startDate, endDate);
    const ds = dataset(interval, market, venue);
    if (!ds.exists) {
        throw new Error(`no ${candleDataset(market, interval, venue)} data in the store; ingest it first`);
    }
    const crypto = market === 'crypto';
    for (const { view, i0, i1 } of ds.scan({ from: startDate.getTime(), to: endDate.getTime(), fields: fieldsFor(market) })) {
        const { ts, order, names } = view;
        const sym = view.symbols();
        const nan = new Float64Array(view.rows).fill(NaN);
        const open = view.cols.open ?? nan;
        const high = view.cols.high ?? nan;
        const low = view.cols.low ?? nan;
        const close = view.cols.close ?? nan;
        const volume = view.cols.volume ?? nan;
        const quoteVolume = crypto ? view.cols.quoteVolume : null;
        let i = i0;
        while (i < i1) {
            const timestamp = ts[order[i]];
            const records = [];
            while (i < i1 && ts[order[i]] === timestamp) {
                const r = order[i++];
                const c = close[r];
                const v = volume[r];
                records.push({
                    stockName: names[sym[r]],
                    candle: new Candle(open[r], high[r], low[r], c, v, timestamp, quoteVolume ? quoteVolume[r] : v * c),
                });
            }
            yield { timestamp, records };
        }
    }
}

/**
 * Streams all candles in timestamp order without materializing per-symbol columns.
 */
export async function* streamAllStocksInRange(interval, startDate, endDate, market = 'stocks', venue = 'binance') {
    for (const group of candleGroups(interval, startDate, endDate, market, venue)) {
        yield* group.records;
    }
}

/**
 * Gets the names of all stocks in the store.
 * @returns {Promise<string[]>} The names of all stocks.
 */
export async function getStockNames(market = 'stocks', interval = '1d', venue = 'binance') {
    return dataset(interval, market, venue).symbolNames();
}

export async function loadFundingInRange(startDate, endDate, venue = 'binance') {
    const out = {};
    const all = funding(venue).read({ from: startDate.getTime(), to: endDate.getTime(), fields: ['rate'] });
    for (const [name, series] of all) {
        out[name] = {
            time: Array.from(series.ts, t => Math.floor(t / 1000) * 1000),
            rate: Array.from(series.rate),
        };
    }
    return out;
}
