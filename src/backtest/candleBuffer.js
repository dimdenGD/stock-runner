import { intervalMsMap, prefetchFactor } from './consts.js';
import { loadStockAfterTimestamp, loadStockBeforeTimestamp } from './loader.js';

/**
 * Returns a plain Candle[] instead of a Stock,
 * so our buffer logic is simpler.
 */
async function fetchCandlesAfter(stockName, interval, startDate, count) {
    const stock = await loadStockAfterTimestamp(stockName, interval, startDate, count);
    return [...stock];         // Stock is iterable over Candle
}

export default class CandleBuffer {
    /**
     * @param {string} stockName – e.g. 'AAPL'
     * @param {string} interval   – 'minute' | 'daily'
     * @param {Date}   startDate  – backtest start
     * @param {Date}   endDate    – backtest end
     * @param {number} lookback   – how many past bars your strategy will ever request
     */
    constructor(stockName, interval, startDate, endDate, lookback) {
      this.stockName = stockName;
      this.interval  = interval;
      this.startDate = startDate;
      this.endDate   = endDate;
      this.lookback  = lookback;
  
      this.ms        = intervalMsMap[interval];
      this.prefetch  = lookback * prefetchFactor;
      this.buffer    = [];        // holds loaded candles in ascending timestamp
      // start fetching from "lookback" bars before the official startDate
      this.nextTs    = new Date(startDate.getTime() - lookback * this.ms);
      this.done      = false;     // whether we've reached endDate or exhausted data
    }
  
    /**
     * Fetches the next chunk of up to `this.prefetch` candles, starting at `this.nextTs`.
     */
    async _fetchChunk() {
      if (this.done) return;
      if (this.nextTs >= this.endDate) {
        this.done = true;
        return;
      }
  
      const chunk = await fetchCandlesAfter(
        this.stockName,
        this.interval,
        this.nextTs,
        this.prefetch
      );
  
      if (chunk.length === 0) {
        this.done = true;
        return;
      }
  
      this.buffer.push(...chunk);
      const lastTs = chunk[chunk.length - 1].timestamp;
      this.nextTs = new Date(lastTs + 1);  // move just past last loaded bar
      if (chunk.length < this.prefetch) this.done = true;
    }
  
    /**
     * Ensures we have enough future data loaded so that any lookback up to
     * `this.lookback` bars before `currentTs` is in `this.buffer`.
     */
    async ensure(currentTs) {
      if (this.buffer.length === 0) {
        // first‐time load
        await this._fetchChunk();
        return;
      }
  
      const lastTs    = this.buffer[this.buffer.length - 1].timestamp;
      const threshold = lastTs - this.lookback * this.ms;
      if (currentTs >= threshold) {
        await this._fetchChunk();
      }
    }
  
    /**
     * Returns the last `count` candles up to (and ≤) `currentTs`, in reverse order:
     * [ newest, ..., oldest ].
     * @param {number} count    number of bars
     * @param {number} currentTs timestamp in ms or Date
     * @returns {Candle[]}
     */
    getLast(count, currentTs) {
      const ts = currentTs instanceof Date ? currentTs.getTime() : currentTs;
      // find first bar with timestamp > ts
      let idx = this.buffer.findIndex(c => c.timestamp > ts);
      if      (idx === -1) idx = this.buffer.length - 1;
      else if (idx > 0)    idx = idx - 1;
      else throw new Error(`No data ≤ ${new Date(ts)}`);
  
      const start = idx - count + 1;
      if (start < 0) {
        throw new Error(
          `Insufficient data in ${this.interval}: need ${count}, have ${idx + 1}`
        );
      }
  
      // slice ascending then reverse -> newest first
      return this.buffer.slice(start, idx + 1).reverse();
    }
  }
  