import { basename } from 'node:path';
import { allowedIntervals } from './consts.js';

export default class Strategy {
    /**
     * @param {Object} options
     * @param {Object[]} options.intervals         — Array of { name, count, main, preload }
     * @param {Function} options.onTick           — Called each tick with context
     * @throws {TypeError} on invalid intervals or onTick
     */
    constructor({ name, params = {}, warmup = 0, intervals, onTick }) {
        if (typeof intervals !== 'object') {
            throw new TypeError('Intervals must be an object');
        }
        for (const iv in intervals) {
            const interval = intervals[iv];
            if (!allowedIntervals.includes(iv)) {
                throw new TypeError(`Invalid interval name: ${iv}`);
            }
            if (interval.count < 1) {
                throw new TypeError('Interval `count` must be >= 1');
            }
        }
        const mains = Object.values(intervals).filter(iv => iv.main);
        if (mains.length !== 1) {
            throw new TypeError('Exactly one interval must have `main: true`');
        }
        if (typeof onTick !== 'function') {
            throw new TypeError('`onTick` must be a function');
        }
        if (!Number.isInteger(warmup) || warmup < 0) {
            throw new TypeError('`warmup` must be a non-negative integer number of bars');
        }
        const resolvedName = name ?? basename(process.argv[1] || 'strategy', '.js');
        if (!/^[A-Za-z0-9._-]+$/.test(resolvedName)) {
            throw new TypeError('`name` may only contain letters, digits, dots, dashes and underscores');
        }

        for(let iv in intervals) {
            const interval = intervals[iv];
            interval.name = iv;
            interval.main = !!interval.main;
            interval.preload = interval.main ? true : !!interval.preload;
        }

        this.name = resolvedName;
        this.params = params;
        this.warmup = warmup;
        this.intervals = intervals;
        this.mainInterval = mains[0];
        this.onTick = onTick;
    }
}
