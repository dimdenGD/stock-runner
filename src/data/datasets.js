import { join } from 'node:path';
import { DEFAULT_ROOT, listDatasets, openDataset } from './store.js';
import { candleDataset, fundingDataset, intervalMsMap, partitionFor } from '../backtest/consts.js';

export const CANDLE_FIELDS = ['open', 'high', 'low', 'close', 'volume', 'quoteVolume'];
export const FUNDING_FIELDS = ['rate', 'intervalHours'];

const opened = new Map();

export function datasetPath(name, root = DEFAULT_ROOT) {
    return join(root, ...name.split('/'));
}

export function dataset(name, { root = DEFAULT_ROOT, ...options } = {}) {
    const path = datasetPath(name, root);
    const hit = opened.get(path);
    if (hit && !options.create) return hit.exists ? hit : (hit.refreshMeta(), hit);
    const ds = openDataset(path, options);
    opened.set(path, ds);
    return ds;
}

export function candles(market, interval, venue = 'binance', { create = false, fields = CANDLE_FIELDS, root } = {}) {
    const name = candleDataset(market, interval, venue);
    return dataset(name, create
        ? { root, create, fields, step: intervalMsMap[interval], partition: partitionFor(market, interval) }
        : { root });
}

export function funding(venue = 'binance', { create = false, root } = {}) {
    return dataset(fundingDataset(venue), create
        ? { root, create, fields: FUNDING_FIELDS, step: 0, partition: 'year' }
        : { root });
}

export { DEFAULT_ROOT, listDatasets };
