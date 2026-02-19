export const allowedIntervals = ['1d', '1h', '5m', '1m'];
export const intervalMsMap = {
    '1d': 1000*60*60*24,
    '1h': 1000*60*60,
    '5m': 1000*60*5,
    '1m': 1000*60
}
export const prefetchFactor = 10;