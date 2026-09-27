import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { endianness } from 'node:os';

if (endianness() !== 'LE') throw new Error('algo-runner data files are little-endian and need a little-endian host');

const MAGIC = 'SRSEG001';
const PREFIX = 16;
const align = (n) => Math.ceil(n / 8) * 8;

function layout(rows, symbols, cov, fields, dataStart) {
    let at = dataStart;
    const take = (bytes) => {
        const offset = at;
        at = align(at + bytes);
        return offset;
    };
    const out = {
        dirStart: take(4 * symbols),
        dirCount: take(4 * symbols),
        dirMin: take(8 * symbols),
        dirMax: take(8 * symbols),
        covSym: take(4 * cov),
        covFrom: take(8 * cov),
        covTo: take(8 * cov),
        ts: take(8 * rows),
        order: take(4 * rows),
        fields: {},
    };
    for (const field of fields) out.fields[field] = take(8 * rows);
    out.end = at;
    return out;
}

export function lowerBound(arr, value, lo = 0, hi = arr.length) {
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function upperBound(arr, value, lo = 0, hi = arr.length) {
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] <= value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function computeOrder(ts, start, count, step = 0) {
    const rows = ts.length;
    const order = new Uint32Array(rows);
    if (!rows) return order;
    let min = Infinity;
    let max = -Infinity;
    for (let s = 0; s < start.length; s++) {
        if (!count[s]) continue;
        if (ts[start[s]] < min) min = ts[start[s]];
        if (ts[start[s] + count[s] - 1] > max) max = ts[start[s] + count[s] - 1];
    }
    let slot = null;
    let slots = 0;
    if (step > 0) {
        const span = (max - min) / step;
        if (Number.isInteger(span) && span < 4 * rows + 1024) {
            slot = new Uint32Array(rows);
            slots = span + 1;
            for (let i = 0; i < rows; i++) {
                const k = (ts[i] - min) / step;
                if (!Number.isInteger(k)) {
                    slot = null;
                    break;
                }
                slot[i] = k;
            }
        }
    }
    if (!slot) {
        const sorted = Float64Array.from(ts).sort();
        let unique = 0;
        for (let i = 0; i < rows; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[unique++] = sorted[i];
        const times = sorted.subarray(0, unique);
        slots = unique;
        slot = new Uint32Array(rows);
        for (let s = 0; s < start.length; s++) {
            const a = start[s];
            const n = count[s];
            if (!n) continue;
            let j = lowerBound(times, ts[a]);
            for (let i = a; i < a + n; i++) {
                while (times[j] < ts[i]) j++;
                slot[i] = j;
            }
        }
    }
    const offsets = new Uint32Array(slots + 1);
    for (let i = 0; i < rows; i++) offsets[slot[i] + 1]++;
    for (let k = 0; k < slots; k++) offsets[k + 1] += offsets[k];
    for (let i = 0; i < rows; i++) order[offsets[slot[i]]++] = i;
    return order;
}

export function encodeSegment({ names, runs, fields, coverage = null, step = 0 }) {
    const symbols = names.length;
    let rows = 0;
    let min = Infinity;
    let max = -Infinity;
    const piecesOf = (run) => run.pieces ?? [run];
    for (const run of runs) {
        const pieces = piecesOf(run);
        for (const piece of pieces) {
            const n = piece.ts.length;
            rows += n;
            if (n) {
                if (piece.ts[0] < min) min = piece.ts[0];
                if (piece.ts[n - 1] > max) max = piece.ts[n - 1];
            }
        }
    }
    const cov = coverage ? coverage.sym.length : 0;
    const json = Buffer.from(JSON.stringify({
        rows, symbols, cov, fields, names: names.join('\n'),
        min: rows ? min : null, max: rows ? max : null,
    }), 'utf8');
    const L = layout(rows, symbols, cov, fields, align(PREFIX + json.length));
    const buffer = new ArrayBuffer(L.end);
    const bytes = new Uint8Array(buffer);
    bytes.set(Buffer.from(MAGIC, 'latin1'), 0);
    new DataView(buffer).setUint32(8, json.length, true);
    bytes.set(json, PREFIX);

    const dirStart = new Uint32Array(buffer, L.dirStart, symbols);
    const dirCount = new Uint32Array(buffer, L.dirCount, symbols);
    const dirMin = new Float64Array(buffer, L.dirMin, symbols);
    const dirMax = new Float64Array(buffer, L.dirMax, symbols);
    const ts = new Float64Array(buffer, L.ts, rows);
    const columns = fields.map(field => new Float64Array(buffer, L.fields[field], rows));
    let at = 0;
    for (let s = 0; s < symbols; s++) {
        const pieces = piecesOf(runs[s]).filter(p => p.ts.length);
        dirStart[s] = at;
        const begin = at;
        for (const piece of pieces) {
            const n = piece.ts.length;
            ts.set(piece.ts, at);
            for (let f = 0; f < fields.length; f++) {
                const source = piece.cols[fields[f]];
                if (source) columns[f].set(source, at);
                else columns[f].fill(NaN, at, at + n);
            }
            at += n;
        }
        dirCount[s] = at - begin;
        dirMin[s] = at > begin ? ts[begin] : NaN;
        dirMax[s] = at > begin ? ts[at - 1] : NaN;
    }
    if (cov) {
        new Uint32Array(buffer, L.covSym, cov).set(coverage.sym);
        new Float64Array(buffer, L.covFrom, cov).set(coverage.from);
        new Float64Array(buffer, L.covTo, cov).set(coverage.to);
    }
    new Uint32Array(buffer, L.order, rows).set(computeOrder(ts, dirStart, dirCount, step));
    return Buffer.from(buffer);
}

function readFully(fd, bytes, position) {
    let done = 0;
    while (done < bytes.length) {
        const n = readSync(fd, bytes, done, bytes.length - done, position + done);
        if (!n) throw Object.assign(new Error('segment file is truncated'), { code: 'ETRUNC' });
        done += n;
    }
}

function preadBuffer(fd, position, byteLength) {
    const buffer = new ArrayBuffer(byteLength);
    if (byteLength) readFully(fd, new Uint8Array(buffer), position);
    return buffer;
}

function parseHeader(prefix, jsonBytes, file) {
    if (Buffer.from(prefix.buffer, prefix.byteOffset, 8).toString('latin1') !== MAGIC) {
        throw new Error(`${file} is not a algo-runner segment`);
    }
    const meta = JSON.parse(Buffer.from(jsonBytes.buffer, jsonBytes.byteOffset, jsonBytes.byteLength).toString('utf8'));
    const L = layout(meta.rows, meta.symbols, meta.cov, meta.fields, align(PREFIX + jsonBytes.byteLength));
    return { meta, L };
}

function headerFrom(meta, L, dir, file, size) {
    const base = L.dirStart;
    const S = meta.symbols;
    const C = meta.cov;
    return {
        file,
        size,
        rows: meta.rows,
        fields: meta.fields,
        names: S ? meta.names.split('\n') : [],
        min: meta.min ?? NaN,
        max: meta.max ?? NaN,
        start: new Uint32Array(dir, L.dirStart - base, S),
        count: new Uint32Array(dir, L.dirCount - base, S),
        dirMin: new Float64Array(dir, L.dirMin - base, S),
        dirMax: new Float64Array(dir, L.dirMax - base, S),
        covSym: new Uint32Array(dir, L.covSym - base, C),
        covFrom: new Float64Array(dir, L.covFrom - base, C),
        covTo: new Float64Array(dir, L.covTo - base, C),
        layout: L,
        index: null,
    };
}

export function readHeader(file) {
    const fd = openSync(file, 'r');
    try {
        const size = fstatSync(fd).size;
        const prefix = new Uint8Array(preadBuffer(fd, 0, PREFIX));
        const jsonLength = new DataView(prefix.buffer).getUint32(8, true);
        const jsonBytes = new Uint8Array(preadBuffer(fd, PREFIX, jsonLength));
        const { meta, L } = parseHeader(prefix, jsonBytes, file);
        if (L.end > size) throw Object.assign(new Error(`${file} is truncated`), { code: 'ETRUNC' });
        const dir = preadBuffer(fd, L.dirStart, L.ts - L.dirStart);
        return headerFrom(meta, L, dir, file, size);
    } finally {
        closeSync(fd);
    }
}

export function readSegment(file, header, fields = null) {
    const wanted = fields ?? header.fields;
    const all = wanted.length === header.fields.length && wanted.every((f, i) => f === header.fields[i]);
    const fd = openSync(file, 'r');
    try {
        const L = header.layout;
        const rows = header.rows;
        const cols = {};
        let ts;
        let order;
        if (all) {
            const buffer = preadBuffer(fd, L.ts, L.end - L.ts);
            ts = new Float64Array(buffer, 0, rows);
            order = new Uint32Array(buffer, L.order - L.ts, rows);
            for (const field of header.fields) cols[field] = new Float64Array(buffer, L.fields[field] - L.ts, rows);
        } else {
            ts = new Float64Array(preadBuffer(fd, L.ts, 8 * rows));
            order = new Uint32Array(preadBuffer(fd, L.order, 4 * rows));
            for (const field of wanted) {
                if (L.fields[field] === undefined) continue;
                cols[field] = new Float64Array(preadBuffer(fd, L.fields[field], 8 * rows));
            }
        }
        return { ts, order, cols };
    } finally {
        closeSync(fd);
    }
}

export function readRuns(file, header, requests, fields) {
    const fd = openSync(file, 'r');
    try {
        const L = header.layout;
        const out = [];
        for (const { sym, from, to } of requests) {
            const start = header.start[sym];
            const count = header.count[sym];
            if (!count) {
                out.push(null);
                continue;
            }
            const ts = new Float64Array(preadBuffer(fd, L.ts + 8 * start, 8 * count));
            const lo = lowerBound(ts, from);
            const hi = upperBound(ts, to);
            if (lo >= hi) {
                out.push(null);
                continue;
            }
            const cols = {};
            for (const field of fields) {
                if (L.fields[field] === undefined) continue;
                cols[field] = new Float64Array(preadBuffer(fd, L.fields[field] + 8 * (start + lo), 8 * (hi - lo)));
            }
            out.push({ ts: ts.subarray(lo, hi), cols });
        }
        return out;
    } finally {
        closeSync(fd);
    }
}
