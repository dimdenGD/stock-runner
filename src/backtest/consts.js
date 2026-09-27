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
    binance: 'Binance USD-M futures',
    hyperliquid: 'Hyperliquid perps',
};

export function checkVenue(venue = 'binance') {
    if (!venues[venue]) throw new TypeError(`venue must be one of: ${Object.keys(venues).join(', ')}`);
    return venue;
}

export function candleDataset(market, interval, venue = 'binance') {
    return market === 'crypto' ? `${checkVenue(venue)}/${interval}` : `stocks/${interval}`;
}

export function fundingDataset(venue = 'binance') {
    return `${checkVenue(venue)}/funding`;
}

const partitions = {
    crypto: { '1m': 'day', '5m': 'week', '15m': 'month', '1h': 'quarter', '4h': 'year', '1d': 'year' },
    stocks: { '1m': 'day', '5m': 'day', '15m': 'week', '1h': 'month', '4h': 'quarter', '1d': 'year' },
};

export function partitionFor(market, interval) {
    return partitions[market]?.[interval] ?? 'month';
}
