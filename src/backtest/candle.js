// volume,open,close,high,low,window_start,transactions
// 2822,57.3,56.78,57.3,56.49,1596168000000000000,42
class Candle {
    constructor(open, high, low, close, volume, transactions, timestamp) {
        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;
        this.volume = volume;
        this.transactions = transactions;
        this.timestamp = timestamp;
    }
}

export default Candle;