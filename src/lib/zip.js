import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const LFH_SIG = 0x04034b50;

export function unzipSingle(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no EOCD)');

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const lhOffset = buf.readUInt32LE(cdOffset + 42);
  if (buf.readUInt32LE(lhOffset) !== LFH_SIG) throw new Error('bad local file header');

  const method = buf.readUInt16LE(lhOffset + 8);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(lhOffset + 26);
  const extraLen = buf.readUInt16LE(lhOffset + 28);
  const start = lhOffset + 30 + nameLen + extraLen;
  const body = buf.subarray(start, start + compSize);

  if (method === 0) return body;
  if (method === 8) return inflateRawSync(body);
  throw new Error(`unsupported zip compression method ${method}`);
}
