import Strategy from './strategy.js';

const strategy = new Strategy({
    intervals: [{ name: '1d', candles: 20, main: true }, { name: '1m', candles: 300 }],
    onTick: async ({ timestamp, getCandles, candle }) => {
        const dayCandles = getCandles('1d', 10);
        const minuteCandles = getCandles('1m', 300);
        
        console.log(candle.close, dayCandles[0].close, minuteCandles[0].close);
    }
});

strategy.run({stockName: 'AAPL', startDate: new Date('2025-04-01'), endDate: new Date()});