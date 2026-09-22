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

export const venues = {
    binance: { candles: 'crypto_candles', funding: 'crypto_funding' },
    hyperliquid: { candles: 'hl_candles', funding: 'hl_funding' },
};

export function venueTables(venue = 'binance') {
    const v = venues[venue];
    if (!v) throw new TypeError(`venue must be one of: ${Object.keys(venues).join(', ')}`);
    return v;
}

export function candleTable(market, interval, venue = 'binance') {
    return market === 'crypto' ? `${venueTables(venue).candles}_${interval}` : `candles_${interval}`;
}

export function fundingTable(venue = 'binance') {
    return venueTables(venue).funding;
}