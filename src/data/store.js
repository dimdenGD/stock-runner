import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SPANS, partitionEnd, partitionKey, partitionKeyPattern, partitionStart } from './partition.js';
import { computeOrder, encodeSegment, lowerBound, readHeader, readRuns, readSegment, upperBound } from './segment.js';

export const DEFAULT_ROOT = process.env.STOCK_RUNNER_STORE
    ? resolve(process.env.STOCK_RUNNER_STORE)
    : fileURLToPath(new URL('../../data/store/', import.meta.url));

const SEGMENT = /^(.+)~(\d{8})\.(\d{4})\.([0-9a-f]{6})\.seg$/;
const PART_FILE = /~tmp\.\d+\.[0-9a-f]+\.part$/;
const RETRY = new Set(['ENOENT', 'EPERM', 'EACCES', 'EBUSY', 'ETRUNC']);
const HOST = hostname();

const nonce = () => randomBytes(3).toString('hex');
const segmentName = (key, seq, ver) => `${key}~${String(seq).padStart(8, '0')}.${String(ver).padStart(4, '0')}.${nonce()}.seg`;
const compareNames = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleeper, 0, 0, ms);

class Lru {
    constructor(maxBytes) {
        this.maxBytes = maxBytes;
        this.bytes = 0;
        this.map = new Map();
    }

    get(key) {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key, value, bytes) {
        this.delete(key);
        if (bytes > this.maxBytes) return value;
        this.map.set(key, { value, bytes });
        this.bytes += bytes;
        while (this.bytes > this.maxBytes) {
            const [oldest, entry] = this.map.entries().next().value;
            this.map.delete(oldest);
            this.bytes -= entry.bytes;
        }
        return value;
    }

    delete(key) {
        const entry = this.map.get(key);
        if (!entry) return;
        this.map.delete(key);
        this.bytes -= entry.bytes;
    }

    clear() {
        this.map.clear();
        this.bytes = 0;
    }
}

const HEADERS = new Lru(Number(process.env.STOCK_RUNNER_HEADER_CACHE_MB || 256) * 2 ** 20);
const VIEWS = new Lru(Number(process.env.STOCK_RUNNER_VIEW_CACHE_MB || 1024) * 2 ** 20);

export function clearCaches() {
    HEADERS.clear();
    VIEWS.clear();
}

const headerBytes = (h) => h.layout.ts - h.layout.dirStart + 64 * h.names.length + 256;

function headerIndex(h) {
    if (!h.index) h.index = new Map(h.names.map((name, i) => [name, i]));
    return h.index;
}

function headerCoverage(h) {
    if (!h.coverage) {
        h.coverage = new Map();
        for (let i = 0; i < h.covSym.length; i++) {
            const name = h.names[h.covSym[i]];
            let list = h.coverage.get(name);
            if (!list) h.coverage.set(name, list = []);
            list.push([h.covFrom[i], h.covTo[i]]);
        }
    }
    return h.coverage;
}

export function mergeIntervals(list, tolerance = 1) {
    if (list.length < 2) return list.map(([a, b]) => [a, b]);
    const sorted = list.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const cur = out[out.length - 1];
        const [a, b] = sorted[i];
        if (a <= cur[1] + tolerance) cur[1] = Math.max(cur[1], b);
        else out.push([a, b]);
    }
    return out;
}

function toFloat64(values, n) {
    if (values instanceof Float64Array) return values;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = values[i] == null ? NaN : +values[i];
    return out;
}

export function normalizeSeries(name, series) {
    if (typeof name !== 'string' || !name || name.includes('\n')) throw new TypeError(`invalid symbol name ${JSON.stringify(name)}`);
    const n = series.ts.length;
    const ts = toFloat64(series.ts, n);
    const cols = {};
    for (const field of Object.keys(series)) {
        if (field === 'ts' || series[field] == null) continue;
        if (series[field].length !== n) throw new TypeError(`${name}: ${field} has ${series[field].length} values for ${n} timestamps`);
        cols[field] = toFloat64(series[field], n);
    }
    let sorted = true;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(ts[i])) throw new TypeError(`${name}: timestamp ${ts[i]} is not a number`);
        if (i && ts[i] <= ts[i - 1]) sorted = false;
    }
    if (sorted) return { ts, cols };
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => ts[a] - ts[b] || a - b);
    const keep = [];
    for (let k = 0; k < n; k++) {
        if (k + 1 < n && ts[idx[k + 1]] === ts[idx[k]]) continue;
        keep.push(idx[k]);
    }
    const out = { ts: Float64Array.from(keep, i => ts[i]), cols: {} };
    for (const field of Object.keys(cols)) out.cols[field] = Float64Array.from(keep, i => cols[field][i]);
    return out;
}

function sliceRun(run, a, b) {
    if (a === 0 && b === run.ts.length) return run;
    const out = { ts: run.ts.slice(a, b), cols: {} };
    for (const field of Object.keys(run.cols)) out.cols[field] = run.cols[field].slice(a, b);
    return out;
}

function viewRun(run, a, b) {
    if (a === 0 && b === run.ts.length) return run;
    const out = { ts: run.ts.subarray(a, b), cols: {} };
    for (const field of Object.keys(run.cols)) out.cols[field] = run.cols[field].subarray(a, b);
    return out;
}

function piecesOf(list) {
    if (list.length === 1) return list[0];
    const sorted = list.slice().sort((x, y) => x.ts[0] - y.ts[0]);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].ts[0] <= sorted[i - 1].ts[sorted[i - 1].ts.length - 1]) return null;
    }
    let n = 0;
    for (const run of sorted) n += run.ts.length;
    const fields = [...new Set(sorted.flatMap(r => Object.keys(r.cols)))];
    return { pieces: sorted, length: n, fields };
}

function concatRuns(runs, fields) {
    if (runs.length === 1) return runs[0];
    let n = 0;
    for (const run of runs) n += run.ts.length;
    const out = { ts: new Float64Array(n), cols: {} };
    for (const field of fields) out.cols[field] = new Float64Array(n);
    let at = 0;
    for (const run of runs) {
        out.ts.set(run.ts, at);
        for (const field of fields) {
            if (run.cols[field]) out.cols[field].set(run.cols[field], at);
            else out.cols[field].fill(NaN, at, at + run.ts.length);
        }
        at += run.ts.length;
    }
    return out;
}

function mergeRuns(runs, fields) {
    const live = runs.filter(r => r && r.run.ts.length);
    if (!live.length) return null;
    if (live.length === 1) return live[0].run;
    const ordered = live.slice().sort((x, y) => x.run.ts[0] - y.run.ts[0] || x.priority - y.priority);
    let disjoint = true;
    for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].run.ts[0] <= ordered[i - 1].run.ts[ordered[i - 1].run.ts.length - 1]) {
            disjoint = false;
            break;
        }
    }
    if (disjoint) return concatRuns(ordered.map(r => r.run), fields);
    const byPriority = live.slice().sort((x, y) => x.priority - y.priority);
    const k = byPriority.length;
    const at = new Uint32Array(k);
    let capacity = 0;
    for (const { run } of byPriority) capacity += run.ts.length;
    const source = new Int32Array(capacity);
    const row = new Uint32Array(capacity);
    let n = 0;
    for (;;) {
        let t = Infinity;
        for (let j = 0; j < k; j++) {
            const ts = byPriority[j].run.ts;
            if (at[j] < ts.length && ts[at[j]] < t) t = ts[at[j]];
        }
        if (t === Infinity) break;
        let winner = -1;
        for (let j = 0; j < k; j++) {
            const ts = byPriority[j].run.ts;
            if (at[j] < ts.length && ts[at[j]] === t) {
                if (winner >= 0) at[winner]++;
                winner = j;
            }
        }
        source[n] = winner;
        row[n] = at[winner]++;
        n++;
    }
    const out = { ts: new Float64Array(n), cols: {} };
    for (const field of fields) out.cols[field] = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const run = byPriority[source[i]].run;
        const r = row[i];
        out.ts[i] = run.ts[r];
        for (const field of fields) out.cols[field][i] = run.cols[field] ? run.cols[field][r] : NaN;
    }
    return out;
}

class View {
    constructor({ key, names, start, count, dirMin, dirMax, ts, order, cols, fields, coverage }) {
        Object.assign(this, { key, names, start, count, dirMin, dirMax, ts, order, cols, fields, coverage });
        this.index = null;
        this.symbolOf = null;
        this.bytes = ts.byteLength + order.byteLength + 24 * names.length + 64 * names.length
            + Object.values(cols).reduce((s, c) => s + c.byteLength, 0);
    }

    get rows() {
        return this.ts.length;
    }

    indexOf(name) {
        if (!this.index) this.index = new Map(this.names.map((n, i) => [n, i]));
        return this.index.get(name);
    }

    symbols() {
        if (!this.symbolOf) {
            this.symbolOf = new Uint32Array(this.rows);
            for (let s = 0; s < this.names.length; s++) this.symbolOf.fill(s, this.start[s], this.start[s] + this.count[s]);
        }
        return this.symbolOf;
    }

    orderRange(from, to) {
        const { ts, order } = this;
        let lo = 0;
        let hi = order.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (ts[order[mid]] < from) lo = mid + 1;
            else hi = mid;
        }
        const i0 = lo;
        hi = order.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (ts[order[mid]] <= to) lo = mid + 1;
            else hi = mid;
        }
        return [i0, lo];
    }

    runRange(sym, from = -Infinity, to = Infinity) {
        const a = this.start[sym];
        const b = a + this.count[sym];
        return [lowerBound(this.ts, from, a, b), upperBound(this.ts, to, a, b)];
    }

    run(sym, from, to, fields) {
        const [a, b] = this.runRange(sym, from, to);
        if (a >= b) return null;
        const out = { ts: this.ts.slice(a, b), cols: {} };
        for (const field of fields) out.cols[field] = this.cols[field] ? this.cols[field].slice(a, b) : new Float64Array(b - a).fill(NaN);
        return out;
    }
}

function coverageArrays(names, coverageByName) {
    const sym = [];
    const from = [];
    const to = [];
    names.forEach((name, i) => {
        for (const [a, b] of coverageByName.get(name) ?? []) {
            sym.push(i);
            from.push(a);
            to.push(b);
        }
    });
    return sym.length ? { sym: Uint32Array.from(sym), from: Float64Array.from(from), to: Float64Array.from(to) } : null;
}

function singleView(key, header, data) {
    const coverage = new Map([...headerCoverage(header)].map(([name, list]) => [name, list.map(([a, b]) => [a, b])]));
    return new View({
        key, names: header.names, start: header.start, count: header.count, dirMin: header.dirMin, dirMax: header.dirMax,
        ts: data.ts, order: data.order, cols: data.cols, fields: Object.keys(data.cols), coverage,
    });
}

function mergedView(key, loaded, fields, step, tolerance) {
    const nameSet = new Set();
    for (const { header } of loaded) for (const name of header.names) nameSet.add(name);
    const names = [...nameSet].sort(compareNames);
    const runs = names.map(() => []);
    const idx = new Map(names.map((n, i) => [n, i]));
    const coverage = new Map();
    loaded.forEach(({ header, ts, cols }, priority) => {
        header.names.forEach((name, j) => {
            const n = header.count[j];
            if (!n) return;
            const a = header.start[j];
            const run = { ts: ts.subarray(a, a + n), cols: {} };
            for (const field of Object.keys(cols)) run.cols[field] = cols[field].subarray(a, a + n);
            runs[idx.get(name)].push({ priority, run });
        });
        for (const [name, list] of headerCoverage(header)) {
            if (!coverage.has(name)) coverage.set(name, []);
            coverage.get(name).push(...list);
        }
    });
    for (const [name, list] of coverage) coverage.set(name, mergeIntervals(list, tolerance));
    const merged = runs.map(list => mergeRuns(list, fields));
    let rows = 0;
    for (const run of merged) if (run) rows += run.ts.length;
    const start = new Uint32Array(names.length);
    const count = new Uint32Array(names.length);
    const dirMin = new Float64Array(names.length);
    const dirMax = new Float64Array(names.length);
    const ts = new Float64Array(rows);
    const cols = Object.fromEntries(fields.map(f => [f, new Float64Array(rows)]));
    let at = 0;
    merged.forEach((run, s) => {
        start[s] = at;
        const n = run ? run.ts.length : 0;
        count[s] = n;
        dirMin[s] = n ? run.ts[0] : NaN;
        dirMax[s] = n ? run.ts[n - 1] : NaN;
        if (!n) return;
        ts.set(run.ts, at);
        for (const field of fields) {
            if (run.cols[field]) cols[field].set(run.cols[field], at);
            else cols[field].fill(NaN, at, at + n);
        }
        at += n;
    });
    const order = computeOrder(ts, start, count, step);
    const keep = names.map((name, s) => count[s] > 0 || coverage.has(name));
    if (keep.every(Boolean)) {
        return new View({ key, names, start, count, dirMin, dirMax, ts, order, cols, fields, coverage });
    }
    const kept = [];
    keep.forEach((k, s) => { if (k) kept.push(s); });
    return new View({
        key,
        names: kept.map(s => names[s]),
        start: Uint32Array.from(kept, s => start[s]),
        count: Uint32Array.from(kept, s => count[s]),
        dirMin: Float64Array.from(kept, s => dirMin[s]),
        dirMax: Float64Array.from(kept, s => dirMax[s]),
        ts, order, cols, fields, coverage,
    });
}

function viewRuns(view, fields) {
    return view.names.map((_, s) => {
        const a = view.start[s];
        const b = a + view.count[s];
        const run = { ts: view.ts.subarray(a, b), cols: {} };
        for (const field of fields) if (view.cols[field]) run.cols[field] = view.cols[field].subarray(a, b);
        return run;
    });
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

function tryUnlink(file, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try {
            unlinkSync(file);
            return true;
        } catch (err) {
            if (err.code === 'ENOENT') return true;
            if (!RETRY.has(err.code)) throw err;
            sleepSync(10 * (i + 1));
        }
    }
    return false;
}

function readMeta(file) {
    for (let attempt = 0; ; attempt++) {
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            if (attempt >= 20) throw err;
            sleepSync(10);
        }
    }
}

export class Dataset {
    constructor(dir, meta, { listTtlMs = 1000, maxSegments = 8, lockTimeoutMs = 120000 } = {}) {
        this.dir = dir;
        this.meta = meta;
        this.listTtlMs = listTtlMs;
        this.maxSegments = maxSegments;
        this.lockTimeoutMs = lockTimeoutMs;
        this.parts = new Map();
        this.keys = [];
        this.bounds = new Map();
        this.listedAt = 0;
    }

    get exists() {
        return this.meta != null;
    }

    get fields() {
        return this.meta?.fields ?? [];
    }

    get step() {
        return this.meta?.step ?? 0;
    }

    get span() {
        return this.meta?.partition ?? 'month';
    }

    get tolerance() {
        return Math.max(1, this.step);
    }

    refreshMeta() {
        const meta = readMeta(join(this.dir, 'meta.json'));
        if (meta) this.meta = meta;
        return this.meta;
    }

    list(force = false) {
        if (!force && this.listedAt && Date.now() - this.listedAt < this.listTtlMs) return this;
        if (!this.meta) this.refreshMeta();
        let names;
        try {
            names = readdirSync(this.dir);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            names = [];
        }
        const parts = new Map();
        if (this.meta) {
            const pattern = partitionKeyPattern(this.span);
            for (const name of names) {
                const m = SEGMENT.exec(name);
                if (!m || !pattern.test(m[1])) continue;
                let list = parts.get(m[1]);
                if (!list) parts.set(m[1], list = []);
                list.push({ key: m[1], seq: +m[2], ver: +m[3], name, file: join(this.dir, name) });
            }
        }
        for (const list of parts.values()) list.sort((a, b) => a.seq - b.seq || a.ver - b.ver || compareNames(a.name, b.name));
        this.parts = parts;
        this.keys = [...parts.keys()].sort();
        this.listedAt = Date.now();
        this.orphans = names.filter(name => PART_FILE.test(name));
        return this;
    }

    invalidate() {
        this.listedAt = 0;
    }

    boundsOf(key) {
        let b = this.bounds.get(key);
        if (!b) this.bounds.set(key, b = [partitionStart(this.span, key), partitionEnd(this.span, key)]);
        return b;
    }

    keysIn(from = -Infinity, to = Infinity) {
        return this.keys.filter(key => {
            const [a, b] = this.boundsOf(key);
            return b > from && a <= to;
        });
    }

    header(seg) {
        let h = HEADERS.get(seg.file);
        if (!h) {
            h = readHeader(seg.file);
            HEADERS.set(seg.file, h, headerBytes(h));
        }
        return h;
    }

    retrying(fn) {
        for (let attempt = 0; ; attempt++) {
            try {
                return fn();
            } catch (err) {
                if (!RETRY.has(err.code) || attempt >= 25) throw err;
                sleepSync(5 + 10 * attempt);
                this.list(true);
            }
        }
    }

    unionFields(headers) {
        const set = new Set();
        for (const h of headers) for (const f of h.fields) set.add(f);
        const ordered = this.fields.filter(f => set.has(f));
        for (const f of set) if (!ordered.includes(f)) ordered.push(f);
        return ordered;
    }

    view(key, fields = null) {
        return this.retrying(() => {
            const segs = this.parts.get(key) ?? [];
            if (!segs.length) return null;
            const sig = `${this.dir}|${segs.map(s => s.name).join(',')}`;
            const full = VIEWS.get(`${sig}|*`);
            if (full) return full;
            const tag = fields ? fields.join(',') : '*';
            const cached = VIEWS.get(`${sig}|${tag}`);
            if (cached) return cached;
            const headers = segs.map(seg => this.header(seg));
            const wanted = fields ?? this.unionFields(headers);
            const loaded = segs.map((seg, i) => ({ header: headers[i], ...readSegment(seg.file, headers[i], fields ? wanted.filter(f => headers[i].fields.includes(f)) : null) }));
            const view = loaded.length === 1
                ? singleView(key, headers[0], loaded[0])
                : mergedView(key, loaded, wanted, this.step, this.tolerance);
            return VIEWS.set(`${sig}|${tag}`, view, view.bytes);
        });
    }

    cachedView(key) {
        const segs = this.parts.get(key) ?? [];
        if (!segs.length) return null;
        return VIEWS.get(`${this.dir}|${segs.map(s => s.name).join(',')}|*`) ?? null;
    }

    *scan({ from = -Infinity, to = Infinity, fields = null } = {}) {
        this.list();
        for (const key of this.keysIn(from, to)) {
            const view = this.view(key, fields);
            if (!view || !view.rows) continue;
            const [i0, i1] = view.orderRange(from, to);
            if (i0 < i1) yield { view, i0, i1 };
        }
    }

    readPartition(key, names, from, to, fields) {
        return this.retrying(() => {
            const out = new Map();
            const cached = this.cachedView(key);
            const segs = this.parts.get(key) ?? [];
            if (cached || names.length > 64) {
                const view = cached ?? this.view(key, fields);
                if (!view) return out;
                for (const name of names) {
                    const s = view.indexOf(name);
                    if (s === undefined) continue;
                    const run = view.run(s, from, to, fields);
                    if (run) out.set(name, run);
                }
                return out;
            }
            const found = new Map();
            segs.forEach((seg, priority) => {
                const h = this.header(seg);
                const index = headerIndex(h);
                const requests = [];
                for (const name of names) {
                    const j = index.get(name);
                    if (j === undefined || !h.count[j] || h.dirMax[j] < from || h.dirMin[j] > to) continue;
                    requests.push({ sym: j, from, to, name });
                }
                if (!requests.length) return;
                readRuns(seg.file, h, requests, fields).forEach((run, i) => {
                    if (!run) return;
                    const name = requests[i].name;
                    if (!found.has(name)) found.set(name, []);
                    found.get(name).push({ priority, run });
                });
            });
            for (const [name, runs] of found) {
                const run = mergeRuns(runs, fields);
                if (!run) continue;
                for (const field of fields) if (!run.cols[field]) run.cols[field] = new Float64Array(run.ts.length).fill(NaN);
                out.set(name, run);
            }
            return out;
        });
    }

    read({ symbols = null, from = -Infinity, to = Infinity, fields = null } = {}) {
        this.list();
        const wanted = fields ?? this.fields;
        const chunks = new Map();
        const push = (name, run) => {
            if (!chunks.has(name)) chunks.set(name, []);
            chunks.get(name).push(run);
        };
        for (const key of this.keysIn(from, to)) {
            if (symbols) {
                for (const [name, run] of this.readPartition(key, symbols, from, to, wanted)) push(name, run);
                continue;
            }
            const view = this.view(key, fields);
            if (!view) continue;
            for (let s = 0; s < view.names.length; s++) {
                if (!view.count[s]) continue;
                const run = view.run(s, from, to, wanted);
                if (run) push(view.names[s], run);
            }
        }
        const out = new Map();
        for (const [name, runs] of chunks) {
            const run = concatRuns(runs, wanted);
            out.set(name, { ts: run.ts, ...run.cols });
        }
        return out;
    }

    series(name, options = {}) {
        return this.read({ ...options, symbols: [name] }).get(name) ?? null;
    }

    has(name, from = -Infinity, to = Infinity) {
        this.list();
        for (const key of this.keysIn(from, to)) {
            const found = this.retrying(() => {
                for (const seg of this.parts.get(key) ?? []) {
                    const h = this.header(seg);
                    const j = headerIndex(h).get(name);
                    if (j === undefined || !h.count[j] || h.dirMax[j] < from || h.dirMin[j] > to) continue;
                    if (h.dirMin[j] >= from || h.dirMax[j] <= to) return true;
                    const [run] = readRuns(seg.file, h, [{ sym: j, from, to }], []);
                    if (run) return true;
                }
                return false;
            });
            if (found) return true;
        }
        return false;
    }

    last(name, { at = Infinity, count = 1, from = -Infinity, fields = null } = {}) {
        this.list();
        const wanted = fields ?? this.fields;
        const keys = this.keysIn(from, at);
        const runs = [];
        let got = 0;
        for (let k = keys.length - 1; k >= 0 && got < count; k--) {
            const run = this.readPartition(keys[k], [name], from, at, wanted).get(name);
            if (!run) continue;
            runs.unshift(run);
            got += run.ts.length;
        }
        if (!runs.length) return null;
        const run = concatRuns(runs, wanted);
        const a = Math.max(0, run.ts.length - count);
        const sliced = sliceRun(run, a, run.ts.length);
        return { ts: sliced.ts, ...sliced.cols };
    }

    first(name, { from = -Infinity, count = 1, to = Infinity, fields = null } = {}) {
        this.list();
        const wanted = fields ?? this.fields;
        const runs = [];
        let got = 0;
        for (const key of this.keysIn(from, to)) {
            if (got >= count) break;
            const run = this.readPartition(key, [name], from, to, wanted).get(name);
            if (!run) continue;
            runs.push(run);
            got += run.ts.length;
        }
        if (!runs.length) return null;
        const run = sliceRun(concatRuns(runs, wanted), 0, Math.min(count, got));
        return { ts: run.ts, ...run.cols };
    }

    partitionStats(key, from, to) {
        return this.retrying(() => {
            const segs = this.parts.get(key) ?? [];
            const [pa, pb] = this.boundsOf(key);
            const inside = pa >= from && pb - 1 <= to;
            const out = new Map();
            if (inside) {
                const headers = segs.map(seg => this.header(seg));
                const seen = new Map();
                let disjoint = true;
                for (const h of headers) {
                    h.names.forEach((name, j) => {
                        if (!h.count[j]) return;
                        const prev = seen.get(name);
                        if (!prev) {
                            seen.set(name, { first: h.dirMin[j], last: h.dirMax[j], count: h.count[j] });
                            return;
                        }
                        if (h.dirMin[j] <= prev.last && h.dirMax[j] >= prev.first) disjoint = false;
                        prev.first = Math.min(prev.first, h.dirMin[j]);
                        prev.last = Math.max(prev.last, h.dirMax[j]);
                        prev.count += h.count[j];
                    });
                }
                if (disjoint) return seen;
            }
            const view = this.view(key, []);
            if (!view) return out;
            for (let s = 0; s < view.names.length; s++) {
                if (!view.count[s]) continue;
                const [a, b] = view.runRange(s, from, to);
                if (a < b) out.set(view.names[s], { first: view.ts[a], last: view.ts[b - 1], count: b - a });
            }
            return out;
        });
    }

    stats({ from = -Infinity, to = Infinity } = {}) {
        this.list();
        const symbols = new Map();
        let rows = 0;
        let first = Infinity;
        let last = -Infinity;
        for (const key of this.keysIn(from, to)) {
            for (const [name, s] of this.partitionStats(key, from, to)) {
                rows += s.count;
                if (s.first < first) first = s.first;
                if (s.last > last) last = s.last;
                const prev = symbols.get(name);
                if (!prev) symbols.set(name, { ...s });
                else {
                    prev.count += s.count;
                    if (s.first < prev.first) prev.first = s.first;
                    if (s.last > prev.last) prev.last = s.last;
                }
            }
        }
        return {
            rows,
            first: rows ? first : null,
            last: rows ? last : null,
            symbols,
            partitions: this.keysIn(from, to).length,
        };
    }

    lastTimestamp() {
        this.list();
        for (let k = this.keys.length - 1; k >= 0; k--) {
            const key = this.keys[k];
            const max = this.retrying(() => {
                let m = -Infinity;
                for (const seg of this.parts.get(key) ?? []) {
                    const h = this.header(seg);
                    if (h.rows && h.max > m) m = h.max;
                }
                return m;
            });
            if (max > -Infinity) return max;
        }
        return null;
    }

    symbolNames() {
        return [...this.stats().symbols.keys()].sort(compareNames);
    }

    coverageMap({ symbols = null, from = -Infinity, to = Infinity } = {}) {
        this.list();
        const want = symbols ? new Set(symbols) : null;
        const all = new Map();
        for (const key of this.keysIn(from, to)) {
            this.retrying(() => {
                for (const seg of this.parts.get(key) ?? []) {
                    for (const [name, list] of headerCoverage(this.header(seg))) {
                        if (want && !want.has(name)) continue;
                        if (!all.has(name)) all.set(name, []);
                        all.get(name).push(...list);
                    }
                }
            });
        }
        for (const [name, list] of all) all.set(name, mergeIntervals(list, this.tolerance));
        return all;
    }

    coverage(name) {
        return this.coverageMap({ symbols: [name] }).get(name) ?? [];
    }

    covered(name, from, to, map = null) {
        const list = map ? map.get(name) ?? [] : this.coverage(name);
        return list.some(([a, b]) => a <= from && b >= to);
    }

    ensureDir() {
        if (!this.meta) throw new Error(`${this.dir} is not a dataset; open it with create: true`);
        mkdirSync(this.dir, { recursive: true });
    }

    lock() {
        const file = join(this.dir, '.lock');
        const token = randomBytes(8).toString('hex');
        const started = Date.now();
        for (let attempt = 0; ; attempt++) {
            try {
                writeFileSync(file, JSON.stringify({ pid: process.pid, host: HOST, at: Date.now(), token }), { flag: 'wx' });
                return { file, token };
            } catch (err) {
                if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
            }
            let info = null;
            let mtime = 0;
            try {
                mtime = statSync(file).mtimeMs;
                info = JSON.parse(readFileSync(file, 'utf8'));
            } catch (err) {
                if (err.code === 'ENOENT') continue;
            }
            const stale = info
                ? (info.host === HOST && info.pid !== process.pid && !pidAlive(info.pid)) || Date.now() - info.at > 10 * 60000
                : mtime && Date.now() - mtime > 5000;
            if (stale) {
                try {
                    const again = JSON.parse(readFileSync(file, 'utf8'));
                    if (!info || again.token === info.token) unlinkSync(file);
                } catch {}
                continue;
            }
            if (Date.now() - started > this.lockTimeoutMs) {
                throw new Error(`${this.dir} is locked by ${info ? `pid ${info.pid} on ${info.host}` : 'another process'}`);
            }
            sleepSync(Math.min(50, 2 + attempt));
        }
    }

    unlock(lock) {
        try {
            const info = JSON.parse(readFileSync(lock.file, 'utf8'));
            if (info.token === lock.token) unlinkSync(lock.file);
        } catch {}
    }

    locked(fn) {
        const lock = this.lock();
        try {
            return fn();
        } finally {
            this.unlock(lock);
        }
    }

    tempFile(key) {
        return join(this.dir, `${key}~tmp.${process.pid}.${randomBytes(6).toString('hex')}.part`);
    }

    cleanOrphans() {
        for (const name of this.orphans ?? []) {
            const file = join(this.dir, name);
            try {
                if (Date.now() - statSync(file).mtimeMs > 3600000) tryUnlink(file, 1);
            } catch {}
        }
        this.orphans = [];
    }

    addFields(fields) {
        const missing = fields.filter(f => !this.fields.includes(f));
        if (!missing.length) return;
        const meta = this.refreshMeta();
        const now = meta.fields.slice();
        for (const f of fields) if (!now.includes(f)) now.push(f);
        if (now.length === meta.fields.length) return;
        const next = { ...meta, fields: now };
        const tmp = join(this.dir, `meta.json.${process.pid}.${nonce()}.tmp`);
        writeFileSync(tmp, JSON.stringify(next, null, 1));
        renameSync(tmp, join(this.dir, 'meta.json'));
        this.meta = next;
    }

    encodePartition(names, runs, coverageByName) {
        const fieldSet = new Set();
        for (const run of runs) for (const f of run.pieces ? run.fields : Object.keys(run.cols)) fieldSet.add(f);
        const fields = this.fields.filter(f => fieldSet.has(f));
        for (const f of fieldSet) if (!fields.includes(f)) fields.push(f);
        return {
            fields,
            buffer: encodeSegment({ names, runs, fields, coverage: coverageArrays(names, coverageByName), step: this.step }),
        };
    }

    commit(built) {
        if (!built.length) return [];
        this.ensureDir();
        const staged = built.map(b => {
            const tmp = this.tempFile(b.key);
            writeFileSync(tmp, b.buffer);
            return { ...b, tmp };
        });
        const names = [];
        try {
            this.locked(() => {
                const fields = new Set();
                for (const b of built) for (const f of b.fields) fields.add(f);
                this.addFields([...fields]);
                this.list(true);
                for (const b of staged) {
                    const segs = this.parts.get(b.key) ?? [];
                    const seq = segs.reduce((m, s) => Math.max(m, s.seq), 0) + 1;
                    const name = segmentName(b.key, seq, 0);
                    renameSync(b.tmp, join(this.dir, name));
                    b.tmp = null;
                    names.push(name);
                }
            });
        } finally {
            for (const b of staged) if (b.tmp) tryUnlink(b.tmp, 2);
        }
        this.invalidate();
        this.list(true);
        this.cleanOrphans();
        return names;
    }

    splitByPartition(entries, coverage) {
        const parts = new Map();
        const part = (key) => {
            let p = parts.get(key);
            if (!p) parts.set(key, p = { runs: new Map(), coverage: new Map() });
            return p;
        };
        for (const [name, run] of entries) {
            const n = run.ts.length;
            let a = 0;
            while (a < n) {
                const key = partitionKey(this.span, run.ts[a]);
                const end = this.boundsOf(key)[1];
                const b = lowerBound(run.ts, end, a, n);
                part(key).runs.set(name, viewRun(run, a, b));
                a = b;
            }
        }
        for (const [name, list] of coverage) {
            for (const [from, to] of list) {
                let at = from;
                while (at <= to) {
                    const key = partitionKey(this.span, at);
                    const [, end] = this.boundsOf(key);
                    const p = part(key);
                    if (!p.coverage.has(name)) p.coverage.set(name, []);
                    p.coverage.get(name).push([at, Math.min(to, end - 1)]);
                    at = end;
                }
            }
        }
        return parts;
    }

    buildPartitions(parts) {
        const built = [];
        for (const key of [...parts.keys()].sort()) {
            const { runs, coverage } = parts.get(key);
            for (const [name, list] of coverage) coverage.set(name, mergeIntervals(list, this.tolerance));
            const names = [...new Set([...runs.keys(), ...coverage.keys()])].sort(compareNames);
            const empty = { ts: new Float64Array(0), cols: {} };
            const { fields, buffer } = this.encodePartition(names, names.map(n => runs.get(n) ?? empty), coverage);
            built.push({ key, fields, buffer });
        }
        return built;
    }

    write(input, { coverage = null, compact = true } = {}) {
        const entries = new Map();
        const source = input instanceof Map ? input : new Map(Object.entries(input ?? {}));
        for (const [name, series] of source) {
            if (!series || !series.ts || !series.ts.length) continue;
            entries.set(name, normalizeSeries(name, series));
        }
        const cov = new Map();
        const covSource = coverage instanceof Map ? coverage : new Map(Object.entries(coverage ?? {}));
        for (const [name, list] of covSource) {
            if (typeof name !== 'string' || !name || name.includes('\n')) throw new TypeError(`invalid symbol name ${JSON.stringify(name)}`);
            const clean = list.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a);
            if (clean.length) cov.set(name, mergeIntervals(clean, this.tolerance));
        }
        if (!entries.size && !cov.size) return { rows: 0, segments: [] };
        const built = this.buildPartitions(this.splitByPartition(entries, cov));
        const segments = this.commit(built);
        if (compact) for (const { key } of built) this.maybeCompact(key);
        let rows = 0;
        for (const run of entries.values()) rows += run.ts.length;
        return { rows, segments };
    }

    maybeCompact(key) {
        this.list(true);
        const segs = this.parts.get(key) ?? [];
        if (segs.length <= this.maxSegments) return false;
        return this.compact(key);
    }

    compact(key, { all = false, coverage = null } = {}) {
        this.list(true);
        const segs = this.parts.get(key) ?? [];
        if (segs.length < (coverage ? 1 : 2)) return false;
        let inputs = segs;
        if (!all) {
            const sizes = segs.map(seg => this.header(seg).size);
            let i = segs.length - 1;
            let acc = sizes[i];
            while (i > 0 && sizes[i - 1] <= 2 * acc) {
                i--;
                acc += sizes[i];
            }
            if (segs.length - i < 2) i = segs.length - 2;
            if (i + 1 > this.maxSegments) i = 0;
            inputs = segs.slice(i);
        }
        let loaded;
        try {
            loaded = inputs.map(seg => {
                const header = this.header(seg);
                return { header, ...readSegment(seg.file, header) };
            });
        } catch (err) {
            if (RETRY.has(err.code)) return false;
            throw err;
        }
        const fields = this.unionFields(loaded.map(l => l.header));
        const view = mergedView(key, loaded, fields, this.step, this.tolerance);
        if (coverage) {
            for (const [name, list] of view.coverage) {
                const next = coverage(name, list);
                if (next.length) view.coverage.set(name, next);
                else view.coverage.delete(name);
            }
        }
        const buffer = encodeSegment({
            names: view.names, runs: viewRuns(view, fields), fields,
            coverage: coverageArrays(view.names, view.coverage), step: this.step,
        });
        const last = inputs[inputs.length - 1];
        const tmp = this.tempFile(key);
        writeFileSync(tmp, buffer);
        let committed = false;
        try {
            this.locked(() => {
                this.list(true);
                const now = new Set((this.parts.get(key) ?? []).map(s => s.name));
                if (!inputs.every(s => now.has(s.name))) return;
                renameSync(tmp, join(this.dir, segmentName(key, last.seq, last.ver + 1)));
                committed = true;
            });
        } finally {
            if (!committed) tryUnlink(tmp, 2);
        }
        if (!committed) return false;
        for (const seg of inputs) tryUnlink(seg.file);
        this.invalidate();
        return true;
    }

    uncover({ from = -Infinity, to = Infinity, symbols = null } = {}) {
        this.list(true);
        const want = symbols ? new Set(symbols) : null;
        const cut = (list) => {
            const out = [];
            for (const [a, b] of list) {
                if (b < from || a > to) {
                    out.push([a, b]);
                    continue;
                }
                if (a < from) out.push([a, from - 1]);
                if (b > to) out.push([to + 1, b]);
            }
            return out;
        };
        let rewritten = 0;
        for (const key of this.keysIn(from, to)) {
            const touched = (this.parts.get(key) ?? []).some(seg => {
                for (const [name, list] of headerCoverage(this.header(seg))) {
                    if ((!want || want.has(name)) && list.some(([a, b]) => b >= from && a <= to)) return true;
                }
                return false;
            });
            if (!touched) continue;
            if (this.compact(key, { all: true, coverage: (name, list) => (!want || want.has(name) ? cut(list) : list) })) rewritten++;
        }
        return rewritten;
    }

    compactAll({ all = true } = {}) {
        this.list(true);
        let n = 0;
        for (const key of this.keys) if ((this.parts.get(key) ?? []).length > 1 && this.compact(key, { all })) n++;
        return n;
    }

    drop({ before }) {
        this.list(true);
        let removed = 0;
        for (const key of this.keys) {
            if (this.boundsOf(key)[1] > before) continue;
            for (const seg of this.parts.get(key) ?? []) {
                try {
                    removed += this.header(seg).rows;
                } catch {}
                tryUnlink(seg.file);
            }
        }
        this.invalidate();
        return removed;
    }

    bulk(options) {
        return new BulkWriter(this, options);
    }
}

class GrowF64 {
    constructor(capacity = 256) {
        this.buffer = new Float64Array(capacity);
        this.length = 0;
    }

    push(value) {
        if (this.length === this.buffer.length) {
            const next = new Float64Array(this.buffer.length * 2);
            next.set(this.buffer);
            this.buffer = next;
        }
        this.buffer[this.length++] = value;
    }

    finish() {
        return this.buffer.slice(0, this.length);
    }
}

export class BulkWriter {
    constructor(ds, { budgetBytes = 512 * 2 ** 20, compact = true, fields = null } = {}) {
        this.ds = ds;
        this.budgetBytes = budgetBytes;
        this.compactOnClose = compact;
        this.rowFields = fields ?? ds.fields;
        this.pending = new Map();
        this.coverage = new Map();
        this.builders = new Map();
        this.bytes = 0;
        this.rows = 0;
        this.touched = new Set();
        this.segments = 0;
    }

    bucket(key, name) {
        let part = this.pending.get(key);
        if (!part) this.pending.set(key, part = new Map());
        let list = part.get(name);
        if (!list) part.set(name, list = []);
        return list;
    }

    add(name, series) {
        if (!series || !series.ts || !series.ts.length) return;
        const run = normalizeSeries(name, series);
        const n = run.ts.length;
        const width = 1 + Object.keys(run.cols).length;
        let a = 0;
        while (a < n) {
            const key = partitionKey(this.ds.span, run.ts[a]);
            const b = lowerBound(run.ts, this.ds.boundsOf(key)[1], a, n);
            this.bucket(key, name).push(viewRun(run, a, b));
            a = b;
        }
        this.rows += n;
        this.bytes += 8 * width * n;
        if (this.bytes > this.budgetBytes) this.flush();
    }

    push(name, ts, values) {
        let builder = this.builders.get(name);
        if (builder && !(ts >= builder.start && ts < builder.end)) {
            this.seal(name, builder);
            builder = null;
        }
        if (!builder) {
            const key = partitionKey(this.ds.span, ts);
            const [start, end] = this.ds.boundsOf(key);
            builder = { key, start, end, ts: new GrowF64(), cols: this.rowFields.map(() => new GrowF64()) };
            this.builders.set(name, builder);
        }
        builder.ts.push(ts);
        for (let f = 0; f < this.rowFields.length; f++) builder.cols[f].push(values[f]);
        this.rows++;
        this.bytes += 8 * (1 + this.rowFields.length);
        if (this.bytes > this.budgetBytes) this.flush();
    }

    seal(name, builder) {
        const series = { ts: builder.ts.finish() };
        this.rowFields.forEach((f, i) => { series[f] = builder.cols[i].finish(); });
        this.bucket(builder.key, name).push(normalizeSeries(name, series));
        this.builders.delete(name);
    }

    cover(name, from, to) {
        if (!this.coverage.has(name)) this.coverage.set(name, []);
        this.coverage.get(name).push([from, to]);
    }

    flush() {
        for (const [name, builder] of [...this.builders]) this.seal(name, builder);
        const entries = new Map();
        const parts = new Map();
        for (const [key, byName] of this.pending) {
            const runs = new Map();
            for (const [name, list] of byName) {
                const run = piecesOf(list) ?? mergeRuns(list.map((run, priority) => ({ priority, run })), [...new Set(list.flatMap(r => Object.keys(r.cols)))]);
                if (run) runs.set(name, run);
            }
            parts.set(key, { runs, coverage: new Map() });
        }
        if (this.coverage.size) {
            const split = this.ds.splitByPartition(entries, new Map([...this.coverage].map(([n, l]) => [n, mergeIntervals(l, this.ds.tolerance)])));
            for (const [key, p] of split) {
                if (!parts.has(key)) parts.set(key, { runs: new Map(), coverage: new Map() });
                parts.get(key).coverage = p.coverage;
            }
        }
        const built = this.ds.buildPartitions(parts);
        this.segments += this.ds.commit(built).length;
        for (const { key } of built) this.touched.add(key);
        this.pending.clear();
        this.coverage.clear();
        this.bytes = 0;
    }

    close() {
        this.flush();
        let compacted = 0;
        if (this.compactOnClose) {
            this.ds.list(true);
            for (const key of [...this.touched].sort()) {
                if ((this.ds.parts.get(key) ?? []).length > 1 && this.ds.compact(key, { all: true })) compacted++;
            }
        }
        return { rows: this.rows, segments: this.segments, compacted, partitions: this.touched.size };
    }
}

export function openDataset(dir, { create = false, fields = null, step = 0, partition = null, ...options } = {}) {
    const path = resolve(dir);
    const metaFile = join(path, 'meta.json');
    let meta = readMeta(metaFile);
    if (!meta && create) {
        if (!SPANS.includes(partition)) throw new TypeError(`partition must be one of ${SPANS.join(', ')}`);
        mkdirSync(path, { recursive: true });
        const fresh = { format: 1, fields: fields ?? [], step: step || 0, partition };
        try {
            writeFileSync(metaFile, JSON.stringify(fresh, null, 1), { flag: 'wx' });
            meta = fresh;
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            meta = readMeta(metaFile);
        }
    }
    const ds = new Dataset(path, meta, options);
    if (meta && fields) {
        const missing = fields.filter(f => !meta.fields.includes(f));
        if (missing.length && create) ds.locked(() => ds.addFields(fields));
    }
    return ds;
}

export function listDatasets(root = DEFAULT_ROOT) {
    const out = [];
    const walk = (dir, prefix) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        if (entries.some(e => e.isFile() && e.name === 'meta.json')) {
            out.push(prefix);
            return;
        }
        for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
    };
    if (existsSync(root)) walk(root, '');
    return out.sort();
}
