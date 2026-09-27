const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i);
const COMMA = 44;
const LF = 10;
const CR = 13;

function slow(buf, s, e) {
    if (s >= e) return NaN;
    const v = parseFloat(buf.toString('latin1', s, e));
    return Number.isNaN(v) ? NaN : v;
}

export function parseNumber(buf, s, e) {
    while (e > s && buf[e - 1] === CR) e--;
    if (s >= e) return NaN;
    let i = s;
    let neg = false;
    if (buf[i] === 45) {
        neg = true;
        i++;
    } else if (buf[i] === 43) {
        i++;
    }
    let mant = 0;
    let digits = 0;
    let scale = 0;
    let dot = false;
    let any = false;
    let exp = 0;
    for (; i < e; i++) {
        const c = buf[i];
        if (c >= 48 && c <= 57) {
            any = true;
            if (mant === 0 && c === 48) {
                if (dot) scale++;
                continue;
            }
            if (digits >= 15) return slow(buf, s, e);
            mant = mant * 10 + (c - 48);
            digits++;
            if (dot) scale++;
        } else if (c === 46 && !dot) {
            dot = true;
        } else if ((c === 101 || c === 69) && any) {
            let j = i + 1;
            let eneg = false;
            if (buf[j] === 45) {
                eneg = true;
                j++;
            } else if (buf[j] === 43) {
                j++;
            }
            if (j >= e) return slow(buf, s, e);
            for (; j < e; j++) {
                const d = buf[j];
                if (d < 48 || d > 57 || exp > 1000) return slow(buf, s, e);
                exp = exp * 10 + (d - 48);
            }
            if (eneg) exp = -exp;
            break;
        } else {
            return slow(buf, s, e);
        }
    }
    if (!any) return slow(buf, s, e);
    const p = exp - scale;
    let v;
    if (mant === 0) v = 0;
    else if (p === 0) v = mant;
    else if (p > 0 && p <= 22) v = mant * POW10[p];
    else if (p < 0 && p >= -22) v = mant / POW10[-p];
    else return slow(buf, s, e);
    return neg ? -v : v;
}

export function parseDateTime(buf, s, e) {
    while (e > s && (buf[e - 1] === CR || buf[e - 1] === 90)) e--;
    if (e - s < 10) return NaN;
    const num = (i, n) => {
        let v = 0;
        for (let k = 0; k < n; k++) {
            const c = buf[s + i + k] - 48;
            if (c < 0 || c > 9) return NaN;
            v = v * 10 + c;
        }
        return v;
    };
    const time = e - s >= 19;
    const ms = e - s >= 23 && buf[s + 19] === 46 ? num(20, 3) : 0;
    return Date.UTC(num(0, 4), num(5, 2) - 1, num(8, 2), time ? num(11, 2) : 0, time ? num(14, 2) : 0, time ? num(17, 2) : 0, ms);
}

export function countLines(buf) {
    let n = 0;
    for (let i = buf.indexOf(LF); i !== -1; i = buf.indexOf(LF, i + 1)) n++;
    if (buf.length && buf[buf.length - 1] !== LF) n++;
    return n;
}

const numericStart = (c) => (c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46;

export function parseCsv(buf, columns, { header = 'auto', dates = [] } = {}) {
    const lines = countLines(buf);
    const want = new Int32Array(Math.max(...columns) + 1).fill(-1);
    columns.forEach((col, k) => { want[col] = k; });
    const isDate = new Uint8Array(want.length);
    for (const col of dates) isDate[col] = 1;
    const out = columns.map(() => new Float64Array(lines));
    let pos = 0;
    const firstLine = buf.indexOf(LF);
    const skipFirst = () => {
        pos = firstLine === -1 ? buf.length : firstLine + 1;
    };
    if (header === true) skipFirst();
    else if (header === 'auto' && buf.length) {
        const probe = Math.min(...columns);
        let s = 0;
        for (let col = 0; col < probe && s < buf.length; col++) {
            const comma = buf.indexOf(COMMA, s);
            s = comma === -1 || (firstLine !== -1 && comma > firstLine) ? buf.length : comma + 1;
        }
        if (s < buf.length && !numericStart(buf[s])) skipFirst();
    }
    let row = 0;
    const last = want.length - 1;
    while (pos < buf.length) {
        let end = buf.indexOf(LF, pos);
        if (end === -1) end = buf.length;
        if (end > pos && !(end === pos + 1 && buf[pos] === CR)) {
            let col = 0;
            let s = pos;
            for (let i = pos; i <= end && col <= last; i++) {
                if (i === end || buf[i] === COMMA) {
                    const k = want[col];
                    if (k >= 0) out[k][row] = isDate[col] ? parseDateTime(buf, s, i) : parseNumber(buf, s, i);
                    col++;
                    s = i + 1;
                }
            }
            for (; col <= last; col++) if (want[col] >= 0) out[want[col]][row] = NaN;
            row++;
        }
        pos = end + 1;
    }
    return row === lines ? out : out.map(a => a.subarray(0, row));
}
