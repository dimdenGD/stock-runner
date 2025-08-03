import Column from './column.js';
import Candle from './candle.js';

class Stock {
    constructor(name, granularity = 1000*60*60*24) {
        this.name = name;
        this.volumes = new Column(Uint32Array);
        this.opens = new Column(Float32Array);
        this.closes = new Column(Float32Array);
        this.highs = new Column(Float32Array);
        this.lows = new Column(Float32Array);
        this.timestamps = new Column(Float64Array);
        this.transactions = new Column(Uint32Array);
        this.timestampIndex = new Map();
        this.granularity = granularity;
    }

    /**
     * Get the size of the stock.
     * @returns {number} The size of the stock.
     */
    get size() {
        return this.volumes.length;
    }

    *[Symbol.iterator]() {
        for (let i = 0; i < this.size; i++) {
            yield this.getCandle(i);
        }
    }

    /**
     * Get the index of the candle at the given timestamp.
     * @param {number} timestamp - The timestamp of the candle.
     * @returns {number} The index of the candle.
     */
    getIndex(timestamp) {
        const index = Math.floor(timestamp / this.granularity) * this.granularity;
        return this.timestampIndex.get(index);
    }

    /**
     * Get a candle from the stock.
     * @param {number} i - The index of the candle.
     * @returns {Candle} The candle.
     */
    getCandle(i) {
        return new Candle(
            this.opens.buffer[i],
            this.highs.buffer[i],
            this.lows.buffer[i],
            this.closes.buffer[i],
            this.volumes.buffer[i],
            this.transactions.buffer[i],
            this.timestamps.buffer[i]
        );
    }

    /**
     * Push a candle to the stock.
     * @param {Candle} candle - The candle to push.
     */
    pushCandle(candle) {
        this.volumes.push(candle.volume);
        this.opens.push(candle.open);
        this.closes.push(candle.close);
        this.highs.push(candle.high);
        this.lows.push(candle.low);
        this.timestamps.push(candle.timestamp);
        this.transactions.push(candle.transactions);
        this.timestampIndex.set(candle.timestamp, this.size - 1);
    }

    /**
     * Finish the stock.
     */
    finish() {
        this.volumes.finish();
        this.opens.finish();
        this.closes.finish();
        this.highs.finish();
        this.lows.finish();
        this.timestamps.finish();
        this.transactions.finish();
    }
}

export default Stock;