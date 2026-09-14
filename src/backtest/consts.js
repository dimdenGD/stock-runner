export const allowedIntervals = ['1d', '4h', '1h', '15m', '5m', '1m'];
export const intervalMsMap = {
    '1d': 1000*60*60*24,
    '4h': 1000*60*60*4,
    '1h': 1000*60*60,
    '15m': 1000*60*15,
    '5m': 1000*60*5,
    '1m': 1000*60
}
export const prefetchFactor = 10;

export const markets = ['stocks', 'crypto'];

export function candleTable(market, interval) {
    return market === 'crypto' ? `crypto_candles_${interval}` : `candles_${interval}`;
}