import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { unzipSingle } from '../lib/zip.js';
import { parseCsv } from './csv.js';

const isZip = (buf) => buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 3 && buf[3] === 4;

parentPort.on('message', ({ id, file, data, columns, header, dates }) => {
    try {
        let buf = data ? Buffer.from(data) : readFileSync(file);
        if (isZip(buf)) buf = unzipSingle(buf);
        const cols = parseCsv(buf, columns, { header, dates }).map(c => (c.byteOffset === 0 && c.byteLength === c.buffer.byteLength ? c : c.slice()));
        parentPort.postMessage({ id, cols }, cols.map(c => c.buffer));
    } catch (error) {
        parentPort.postMessage({ id, error: error.message });
    }
});
