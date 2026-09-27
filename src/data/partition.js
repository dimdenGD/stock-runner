const HOUR = 3600000;
const DAY = 86400000;

export const SPANS = ['hour', 'day', 'week', 'month', 'quarter', 'year'];

const iso = (ms) => new Date(ms).toISOString();

export function partitionKey(span, ts) {
    switch (span) {
        case 'hour': return iso(Math.floor(ts / HOUR) * HOUR).slice(0, 13);
        case 'day': return iso(ts).slice(0, 10);
        case 'week': {
            const day = Math.floor(ts / DAY);
            return iso((day - (((day + 3) % 7) + 7) % 7) * DAY).slice(0, 10);
        }
        case 'month': return iso(ts).slice(0, 7);
        case 'quarter': {
            const d = new Date(ts);
            return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
        }
        case 'year': return String(new Date(ts).getUTCFullYear());
        default: throw new TypeError(`unknown partition span ${span}`);
    }
}

export function partitionStart(span, key) {
    switch (span) {
        case 'hour': return Date.parse(`${key}:00:00Z`);
        case 'day':
        case 'week': return Date.parse(`${key}T00:00:00Z`);
        case 'month': return Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 1);
        case 'quarter': return Date.UTC(+key.slice(0, 4), (+key.slice(6) - 1) * 3, 1);
        case 'year': return Date.UTC(+key, 0, 1);
        default: throw new TypeError(`unknown partition span ${span}`);
    }
}

export function partitionEnd(span, key) {
    const start = partitionStart(span, key);
    switch (span) {
        case 'hour': return start + HOUR;
        case 'day': return start + DAY;
        case 'week': return start + 7 * DAY;
        case 'month': {
            const d = new Date(start);
            return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        }
        case 'quarter': {
            const d = new Date(start);
            return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 1);
        }
        case 'year': return Date.UTC(+key + 1, 0, 1);
        default: throw new TypeError(`unknown partition span ${span}`);
    }
}

export function partitionKeyPattern(span) {
    switch (span) {
        case 'hour': return /^\d{4}-\d{2}-\d{2}T\d{2}$/;
        case 'day':
        case 'week': return /^\d{4}-\d{2}-\d{2}$/;
        case 'month': return /^\d{4}-\d{2}$/;
        case 'quarter': return /^\d{4}-Q[1-4]$/;
        case 'year': return /^\d{4}$/;
        default: throw new TypeError(`unknown partition span ${span}`);
    }
}
