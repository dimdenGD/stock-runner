import { intervalMsMap, prefetchFactor } from './consts.js';
import { loadStockAfterTimestamp } from './loader.js';

async function fetchCandlesAfter(stockName, interval, startDate, count, market) {
    const stock = await loadStockAfterTimestamp(stockName, interval, startDate, count, market);
    return [...stock];
}

export default class CandleBuffer {
    constructor(stockName, interval, startDate, endDate, lookback, prefetch, market = 'stocks') {
        this.stockName = stockName;
        this.market = market;
        this.interval = interval;
        this.startDate = startDate;
        this.endDate = endDate;
        this.lookback = lookback;
        this.ms = intervalMsMap[interval];
        this.prefetch = prefetch || Math.max(lookback * prefetchFactor, 100);
        this.buffer = [];
        this.nextTs = new Date(startDate.getTime() - lookback * this.ms);
        this.done = false;
    }

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
            this.prefetch,
            this.market,
        );
        if (chunk.length === 0) {
            this.done = true;
            return;
        }
        this.buffer.push(...chunk);
        this.nextTs = new Date(chunk.at(-1).timestamp + 1);
        if (chunk.length < this.prefetch) this.done = true;
    }

    needsFetch(currentTs) {
        if (this.done) return false;
        if (this.buffer.length === 0) return true;
        return currentTs >= this.buffer.at(-1).timestamp - this.lookback * this.ms;
    }

    async ensure(currentTs) {
        if (this.needsFetch(currentTs)) await this._fetchChunk();
    }

    getLast(count, currentTs) {
        const ts = currentTs instanceof Date ? currentTs.getTime() : currentTs;
        let lo = 0;
        let hi = this.buffer.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.buffer[mid].timestamp <= ts) lo = mid + 1;
            else hi = mid;
        }
        const idx = lo - 1;
        if (idx < 0) throw new Error(`No data <= ${new Date(ts)}`);
        const start = idx - count + 1;
        if (start < 0) {
            throw new Error(`Insufficient data in ${this.interval}: need ${count}, have ${idx + 1}`);
        }
        return this.buffer.slice(start, idx + 1).reverse();
    }
}
