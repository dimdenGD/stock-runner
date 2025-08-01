// volume,open,close,high,low,window_start,transactions
// 2822,57.3,56.78,57.3,56.49,1596168000000000000,42
class Candle {
    constructor(open, high, low, close, volume, timestamp, transactions) {
        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;
        this.volume = volume;
        this.timestamp = timestamp;
        this.transactions = transactions;
    }
}

export default Candle;