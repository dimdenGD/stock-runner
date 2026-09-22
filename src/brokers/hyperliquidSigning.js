import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

const enc = new TextEncoder();

const hexToBytes = (hex) => {
    const h = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (h.length % 2) throw new Error(`odd-length hex: ${hex}`);
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
    return out;
};

const bytesToHex = (bytes) => '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
};

const uintBytes = (value, width) => {
    const out = new Uint8Array(width);
    let v = BigInt(value);
    for (let i = width - 1; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
    return out;
};

export function msgpack(value) {
    if (value === null || value === undefined) return Uint8Array.of(0xc0);
    if (value === true) return Uint8Array.of(0xc3);
    if (value === false) return Uint8Array.of(0xc2);
    if (typeof value === 'number' || typeof value === 'bigint') {
        const n = BigInt(value);
        if (typeof value === 'number' && !Number.isInteger(value)) throw new TypeError(`msgpack: floats are not hashed by Hyperliquid (${value})`);
        if (n >= 0n) {
            if (n < 128n) return Uint8Array.of(Number(n));
            if (n < 256n) return Uint8Array.of(0xcc, Number(n));
            if (n < 65536n) return concat(Uint8Array.of(0xcd), uintBytes(n, 2));
            if (n < 4294967296n) return concat(Uint8Array.of(0xce), uintBytes(n, 4));
            return concat(Uint8Array.of(0xcf), uintBytes(n, 8));
        }
        if (n >= -32n) return Uint8Array.of(Number(n & 0xffn));
        if (n >= -128n) return Uint8Array.of(0xd0, Number(n & 0xffn));
        if (n >= -32768n) return concat(Uint8Array.of(0xd1), uintBytes(n & 0xffffn, 2));
        if (n >= -2147483648n) return concat(Uint8Array.of(0xd2), uintBytes(n & 0xffffffffn, 4));
        return concat(Uint8Array.of(0xd3), uintBytes(n & 0xffffffffffffffffn, 8));
    }
    if (typeof value === 'string') {
        const b = enc.encode(value);
        if (b.length < 32) return concat(Uint8Array.of(0xa0 | b.length), b);
        if (b.length < 256) return concat(Uint8Array.of(0xd9, b.length), b);
        if (b.length < 65536) return concat(Uint8Array.of(0xda), uintBytes(b.length, 2), b);
        return concat(Uint8Array.of(0xdb), uintBytes(b.length, 4), b);
    }
    if (Array.isArray(value)) {
        const head = value.length < 16 ? Uint8Array.of(0x90 | value.length)
            : value.length < 65536 ? concat(Uint8Array.of(0xdc), uintBytes(value.length, 2))
                : concat(Uint8Array.of(0xdd), uintBytes(value.length, 4));
        return concat(head, ...value.map(msgpack));
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value);
        const head = entries.length < 16 ? Uint8Array.of(0x80 | entries.length)
            : entries.length < 65536 ? concat(Uint8Array.of(0xde), uintBytes(entries.length, 2))
                : concat(Uint8Array.of(0xdf), uintBytes(entries.length, 4));
        return concat(head, ...entries.flatMap(([k, v]) => [msgpack(k), msgpack(v)]));
    }
    throw new TypeError(`msgpack: unsupported ${typeof value}`);
}

export function actionHash(action, vaultAddress, nonce, expiresAfter = null) {
    const parts = [msgpack(action), uintBytes(nonce, 8)];
    parts.push(vaultAddress ? concat(Uint8Array.of(1), hexToBytes(vaultAddress)) : Uint8Array.of(0));
    if (expiresAfter != null) parts.push(concat(Uint8Array.of(0), uintBytes(expiresAfter, 8)));
    return keccak_256(concat(...parts));
}

const keccakStr = (s) => keccak_256(enc.encode(s));
const DOMAIN_TYPEHASH = keccakStr('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const AGENT_TYPEHASH = keccakStr('Agent(string source,bytes32 connectionId)');
const L1_DOMAIN = keccak_256(concat(
    DOMAIN_TYPEHASH,
    keccakStr('Exchange'),
    keccakStr('1'),
    uintBytes(1337, 32),
    new Uint8Array(32),
));

export function agentDigest(connectionId, isMainnet) {
    const structHash = keccak_256(concat(AGENT_TYPEHASH, keccakStr(isMainnet ? 'a' : 'b'), connectionId));
    return keccak_256(concat(Uint8Array.of(0x19, 0x01), L1_DOMAIN, structHash));
}

export function signDigest(digest, privateKey) {
    const sig = secp256k1.sign(digest, hexToBytes(privateKey), { lowS: true });
    return {
        r: '0x' + sig.r.toString(16),
        s: '0x' + sig.s.toString(16),
        v: 27 + sig.recovery,
    };
}

export function signL1Action(privateKey, action, vaultAddress, nonce, expiresAfter, isMainnet) {
    return signDigest(agentDigest(actionHash(action, vaultAddress, nonce, expiresAfter), isMainnet), privateKey);
}

export function addressOf(privateKey) {
    const pub = secp256k1.getPublicKey(hexToBytes(privateKey), false).slice(1);
    return bytesToHex(keccak_256(pub).slice(12));
}

export function floatToWire(x) {
    const rounded = Number(x).toFixed(8);
    if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire causes rounding: ${x}`);
    let s = rounded.includes('.') ? rounded.replace(/0+$/, '').replace(/\.$/, '') : rounded;
    if (s === '-0') s = '0';
    return s;
}

export function floatToIntForHashing(x) {
    const n = x * 1e8;
    if (Math.abs(Math.round(n) - n) >= 1e-3) throw new Error(`floatToInt causes rounding: ${x}`);
    return Math.round(n);
}

export { hexToBytes, bytesToHex };
