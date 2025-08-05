import { allowedIntervals } from './consts.js';

export default class Strategy {
    /**
     * @param {Object} options
     * @param {Object[]} options.intervals         — Array of { name, count, main, preload }
     * @param {Function} options.onTick           — Called each tick with context
     * @throws {TypeError} on invalid intervals or onTick
     */
    constructor({ intervals, onTick }) {
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

        for(let iv in intervals) {
            const interval = intervals[iv];
            interval.name = iv;
            interval.main = !!interval.main;
            interval.preload = interval.main ? true : !!interval.preload;
        }

        this.intervals = intervals;
        this.mainInterval = mains[0];
        this.onTick = onTick;
    }
}
