import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

export async function* parseCsvFiles(items, { columns, header = 'auto', dates = [], threads = Math.max(1, availableParallelism() - 1), window = null, load = null } = {}) {
    if (!items.length) return;
    const n = Math.min(threads, items.length);
    const workers = Array.from({ length: n }, () => new Worker(new URL('./csvWorker.js', import.meta.url)));
    const pending = new Map();
    const fail = (error) => {
        for (const p of pending.values()) p.reject(error);
        pending.clear();
    };
    for (const worker of workers) {
        worker.on('message', ({ id, cols, error }) => {
            const p = pending.get(id);
            if (!p) return;
            pending.delete(id);
            if (error) p.reject(new Error(`${items[id].file ?? items[id].url}: ${error}`));
            else p.resolve(cols);
        });
        worker.on('error', fail);
    }
    const parse = (id, data) => new Promise((resolve, reject) => {
        const item = items[id];
        pending.set(id, { resolve, reject });
        const message = { id, file: item.file, columns: item.columns ?? columns, header, dates: item.dates ?? dates };
        if (data) {
            const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            workers[id % n].postMessage({ ...message, data: buffer }, [buffer]);
        } else {
            workers[id % n].postMessage(message);
        }
    });
    const inflight = [];
    let next = 0;
    const submit = () => {
        if (next >= items.length) return;
        const id = next++;
        const cols = load
            ? Promise.resolve(load(items[id])).then(data => (data ? parse(id, data) : null))
            : parse(id, null);
        inflight.push(cols.then(result => ({ item: items[id], cols: result })));
    };
    try {
        for (let i = 0; i < (window ?? n * 4); i++) submit();
        while (inflight.length) {
            const result = await inflight.shift();
            submit();
            yield result;
        }
    } finally {
        for (const p of inflight) p.catch(() => {});
        await Promise.all(workers.map(w => w.terminate()));
    }
}
