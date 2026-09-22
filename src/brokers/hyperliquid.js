import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Broker from './base.js';
import HyperliquidCandleStream, { hyperliquidCandle } from './hyperliquidCandleStream.js';
import { signL1Action, addressOf, floatToWire } from './hyperliquidSigning.js';

const MAINNET = 'https://api.hyperliquid.xyz';
const TESTNET = 'https://api.hyperliquid-testnet.xyz';
const MIN_ORDER_USD = 10;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class HyperliquidError extends Error {
    constructor(message, { status = null, code = null, body = null } = {}) {
        super(message);
        this.name = 'HyperliquidError';
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

class MinuteWeightLimiter {
    constructor(maxWeight) {
        this.maxWeight = maxWeight;
        this.used = 0;
        this.windowStarted = Date.now();
        this.chain = Promise.resolve();
    }

    acquire(weight) {
        const run = async () => {
            const now = Date.now();
            if (now - this.windowStarted >= 60000) {
                this.windowStarted = now;
                this.used = 0;
            }
            if (this.used + weight > this.maxWeight) {
                await sleep(Math.max(1, 60000 - (now - this.windowStarted)));
                this.windowStarted = Date.now();
                this.used = 0;
            }
            this.used += weight;
        };
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => {});
        return next;
    }
}

export function orderPrice(px, szDecimals) {
    const sig = Number(px.toPrecision(5));
    const decimals = Math.max(0, 6 - szDecimals);
    return Number(sig.toFixed(decimals));
}

export default class Hyperliquid extends Broker {
    constructor({
        feeBps = 4.5,
        slippage = 0,
        impactCoef = 1,
        depthRatio = 0.25,
        environment = 'testnet',
        privateKey = null,
        accountAddress = null,
        vaultAddress = null,
        baseUrl,
        webSocketUrl,
        webSocketImpl = globalThis.WebSocket,
        timeoutMs = 15000,
        maxRequestWeightPerMinute = 1000,
        marketSlippage = 0.05,
        fetchImpl = globalThis.fetch,
        strictQuantization = false,
        metaCachePath = 'data/hyperliquid/meta.json',
        metaMaxAgeMs = 7 * 86400000,
    } = {}) {
        super();
        if (!['testnet', 'mainnet'].includes(environment)) throw new TypeError("environment must be 'testnet' or 'mainnet'");
        if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
        this.market = 'crypto';
        this.venue = 'hyperliquid';
        this.feeBps = feeBps;
        this.slippage = slippage;
        this.impactCoef = impactCoef;
        this.depthRatio = depthRatio;
        this.environment = environment;
        this.privateKey = privateKey;
        this.accountAddress = (accountAddress || (privateKey ? addressOf(privateKey) : null))?.toLowerCase() ?? null;
        this.vaultAddress = vaultAddress ? vaultAddress.toLowerCase() : null;
        this.baseUrl = (baseUrl || (environment === 'mainnet' ? MAINNET : TESTNET)).replace(/\/$/, '');
        this.marketDataBaseUrl = MAINNET;
        this.webSocketUrl = webSocketUrl || 'wss://api.hyperliquid.xyz/ws';
        this.webSocketImpl = webSocketImpl;
        this.timeoutMs = timeoutMs;
        this.marketSlippage = marketSlippage;
        this.fetchImpl = fetchImpl;
        this.strictQuantization = strictQuantization;
        this.metaCachePath = metaCachePath;
        this.metaMaxAgeMs = metaMaxAgeMs;
        this.symbolRules = new Map();
        this.unquantizedSymbols = new Set();
        this.lastNonce = 0;
        this.limiter = new MinuteWeightLimiter(maxRequestWeightPerMinute);
    }

    get isMainnet() { return this.environment === 'mainnet'; }

    get label() {
        return `Hyperliquid ${this.environment}`;
    }

    get dataSource() {
        return `hyperliquid-${new URL(this.baseUrl).host}`;
    }

    get account() {
        const who = this.vaultAddress || this.accountAddress;
        const suffix = who ? `-${createHash('sha256').update(who).digest('hex').slice(0, 10)}` : '';
        return `hyperliquid-${this.environment}${suffix}`;
    }

    get tradingMode() {
        return this.isMainnet ? 'live' : 'demo';
    }

    get user() {
        const who = this.vaultAddress || this.accountAddress;
        if (!who) throw new Error('Hyperliquid needs accountAddress (or privateKey) for account requests');
        return who;
    }

    calculateFees(quantity, price, side, candle) {
        const notional = quantity * price;
        let fee = notional * (this.feeBps / 1e4 + this.slippage);
        if (this.impactCoef > 0 && candle && candle.quoteVolume > 0) {
            const frac = notional / (this.depthRatio * candle.quoteVolume);
            fee += notional * this.impactCoef * Math.min(0.05, (0.01 * frac) / 2);
        }
        return fee;
    }

    executionPrice(quantity, price, side, candle) {
        const notional = quantity * price;
        if (!(notional > 0)) return price;
        let fraction = this.slippage;
        if (this.impactCoef > 0 && candle && candle.quoteVolume > 0) {
            const frac = notional / (this.depthRatio * candle.quoteVolume);
            fraction += this.impactCoef * Math.min(0.05, (0.01 * frac) / 2);
        }
        return side === 'buy' ? price * (1 + fraction) : price * (1 - fraction);
    }

    async post(path, body, { weight = 20, retry = true, base = this.baseUrl } = {}) {
        await this.limiter.acquire(weight);
        const attempts = retry ? 4 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const res = await this.fetchImpl(`${base}${path}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                const raw = await res.text();
                let parsed;
                try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = raw; }
                if (res.ok) return parsed;
                const err = new HyperliquidError(`Hyperliquid POST ${path} failed: HTTP ${res.status} ${typeof parsed === 'string' ? parsed.slice(0, 200) : ''}`.trim(),
                    { status: res.status, body: parsed });
                if (attempt + 1 >= attempts || (res.status !== 429 && res.status < 500)) throw err;
                await sleep(1000 * 2 ** attempt);
            } catch (err) {
                if (attempt + 1 >= attempts || err instanceof HyperliquidError) throw err;
                await sleep(1000 * 2 ** attempt);
            } finally {
                clearTimeout(timer);
            }
        }
        throw new Error('unreachable');
    }

    info(body, weight = 20) {
        return this.post('/info', body, { weight });
    }

    nextNonce() {
        this.lastNonce = Math.max(Date.now(), this.lastNonce + 1);
        return this.lastNonce;
    }

    async exchange(action, { weight = 1 } = {}) {
        if (!this.privateKey) throw new Error('Hyperliquid trading needs privateKey (an API wallet key)');
        const nonce = this.nextNonce();
        const signature = signL1Action(this.privateKey, action, this.vaultAddress, nonce, null, this.isMainnet);
        const body = await this.post('/exchange', { action, nonce, signature, vaultAddress: this.vaultAddress }, { weight, retry: false });
        if (body?.status !== 'ok') {
            throw new HyperliquidError(`Hyperliquid ${action.type} rejected: ${typeof body?.response === 'string' ? body.response : JSON.stringify(body)}`,
                { status: 400, body });
        }
        return body.response;
    }

    applyMeta(meta) {
        this.symbolRules.clear();
        (meta.universe || []).forEach((u, asset) => {
            this.symbolRules.set(u.name, {
                asset,
                szDecimals: Number(u.szDecimals),
                step: 10 ** -Number(u.szDecimals),
                maxLeverage: Number(u.maxLeverage) || null,
                onlyIsolated: !!u.onlyIsolated,
                delisted: !!u.isDelisted,
            });
        });
        return this.symbolRules;
    }

    async loadMeta() {
        const meta = await this.info({ type: 'meta' });
        this.applyMeta(meta);
        return meta;
    }

    async prepareBacktest() {
        if (this.symbolRules.size) return;
        let meta = null;
        try {
            if (Date.now() - statSync(this.metaCachePath).mtimeMs < this.metaMaxAgeMs) meta = JSON.parse(readFileSync(this.metaCachePath, 'utf8'));
        } catch {}
        if (!meta) {
            meta = await this.post('/info', { type: 'meta' }, { base: MAINNET });
            try {
                mkdirSync(dirname(this.metaCachePath), { recursive: true });
                writeFileSync(this.metaCachePath, JSON.stringify(meta));
            } catch {}
        }
        this.applyMeta(meta);
        return this.symbolRules.size;
    }

    async initialize() {
        await this.loadMeta();
        if (this.privateKey) {
            const role = await this.info({ type: 'userRole', user: addressOf(this.privateKey) }, 60).catch(() => null);
            if (role?.role === 'missing' && addressOf(this.privateKey) !== this.accountAddress) {
                throw new Error(`Hyperliquid key ${addressOf(this.privateKey)} is not an API wallet of ${this.accountAddress}`);
            }
        }
    }

    async excludedSymbols() {
        if (!this.symbolRules.size) await this.prepareBacktest();
        return new Set([...this.symbolRules].filter(([, r]) => r.onlyIsolated).map(([s]) => s));
    }

    async getTradableSymbols() {
        await this.loadMeta();
        return [...this.symbolRules].filter(([, r]) => !r.delisted && !r.onlyIsolated).map(([s]) => s).sort();
    }

    async getPortfolio() {
        const state = await this.info({ type: 'clearinghouseState', user: this.user }, 2);
        const summary = state.marginSummary || {};
        return {
            cash: Number(state.withdrawable ?? 0),
            available: Number(state.withdrawable ?? 0),
            equity: Number(summary.accountValue ?? 0),
            positions: (state.assetPositions || []).map(({ position: p }) => {
                const qty = Number(p.szi);
                return {
                    symbol: p.coin,
                    quantity: qty,
                    markPrice: qty ? Math.abs(Number(p.positionValue) / qty) : NaN,
                    entryPrice: Number(p.entryPx),
                    unrealizedPnl: Number(p.unrealizedPnl),
                    leverage: Number(p.leverage?.value) || null,
                    marginType: p.leverage?.type ?? null,
                    maxNotionalValue: null,
                    liquidationPrice: Number(p.liquidationPx) || null,
                };
            }),
        };
    }

    async candles(symbol, interval, startTime, endTime) {
        const rows = await this.post('/info', { type: 'candleSnapshot', req: { coin: symbol, interval, startTime, endTime } },
            { weight: 20 + Math.ceil(Math.max(1, (endTime - startTime) / 3600000) / 60), base: this.marketDataBaseUrl });
        return Array.isArray(rows) ? rows : [];
    }

    async getHistory(symbol, interval, bars, { endTime = this.now(), stepMs } = {}) {
        const rows = await this.candles(symbol, interval, endTime - (bars + 1) * stepMs, endTime);
        return rows
            .filter(c => Number(c.t) + stepMs <= endTime)
            .map(c => hyperliquidCandle(c, stepMs))
            .slice(-bars);
    }

    async getClosedCandle(symbol, interval, timestamp, { stepMs } = {}) {
        if (timestamp > this.now()) return null;
        const rows = await this.candles(symbol, interval, timestamp - stepMs, timestamp - 1);
        const c = rows.find(row => Number(row.t) + stepMs === timestamp);
        return c ? hyperliquidCandle(c, stepMs) : null;
    }

    createStream({ symbols, interval, stepMs, graceMs, logger }) {
        return new HyperliquidCandleStream({
            symbols, interval, stepMs, graceMs, logger,
            url: this.webSocketUrl,
            webSocketImpl: this.webSocketImpl,
        });
    }

    quantize(symbol, signedQty, price, { reduceOnly = false } = {}) {
        const r = this.symbolRules.get(symbol);
        if (!r) {
            if (this.strictQuantization) throw new Error(`No Hyperliquid rules for ${symbol}`);
            this.unquantizedSymbols.add(symbol);
            return signedQty;
        }
        const rounded = Math.floor((Math.abs(signedQty) + r.step * 1e-9) / r.step) * r.step;
        if (!(rounded > 0)) return 0;
        if (!reduceOnly && price > 0 && rounded * price < MIN_ORDER_USD) return 0;
        return Math.sign(signedQty) * Number(rounded.toFixed(r.szDecimals));
    }

    normalizeQuantity(symbol, quantity, price, { reduceOnly = false } = {}) {
        if (!this.symbolRules.has(symbol)) throw new Error(`No Hyperliquid rules for ${symbol}`);
        const signed = this.quantize(symbol, quantity, price, { reduceOnly });
        if (!signed) return null;
        return Math.abs(signed).toFixed(this.symbolRules.get(symbol).szDecimals);
    }

    createClientOrderId(parts) {
        return '0x' + createHash('sha256').update(super.createClientOrderId(parts)).digest('hex').slice(0, 32);
    }

    async midPrice(symbol) {
        const mids = await this.info({ type: 'allMids' }, 2);
        const px = Number(mids?.[symbol]);
        if (!(px > 0)) throw new HyperliquidError(`Hyperliquid has no mid price for ${symbol}`, { status: 400 });
        return px;
    }

    async placeMarketOrder({ symbol, side, quantity, reduceOnly = false, clientOrderId }) {
        if (!['buy', 'sell'].includes(side)) throw new TypeError('side must be buy or sell');
        const r = this.symbolRules.get(symbol);
        if (!r) throw new Error(`No Hyperliquid rules for ${symbol}`);
        const mid = await this.midPrice(symbol);
        const px = orderPrice(side === 'buy' ? mid * (1 + this.marketSlippage) : mid * (1 - this.marketSlippage), r.szDecimals);
        const wire = { a: r.asset, b: side === 'buy', p: floatToWire(px), s: floatToWire(Number(quantity)), r: !!reduceOnly, t: { limit: { tif: 'Ioc' } } };
        if (clientOrderId) wire.c = clientOrderId;
        const response = await this.exchange({ type: 'order', orders: [wire], grouping: 'na' });
        const status = response?.data?.statuses?.[0] || {};
        if (status.error) throw new HyperliquidError(`Hyperliquid order rejected: ${status.error}`, { status: 400, body: status });
        const filled = status.filled;
        return {
            symbol,
            side,
            clientOrderId,
            orderId: filled?.oid ?? status.resting?.oid ?? null,
            status: filled && Number(filled.totalSz) > 0 ? 'FILLED' : 'EXPIRED',
            executedQty: filled?.totalSz ?? '0',
            avgPrice: filled?.avgPx ?? '0',
            requestedQty: String(quantity),
            limitPrice: px,
            raw: status,
        };
    }

    parseOrderResult(result) {
        if (!result || typeof result !== 'object') return {};
        return {
            exchangeOrderId: result.orderId,
            status: result.status,
            executedQty: Number(result.executedQty),
            avgPrice: Number(result.avgPrice) > 0 ? Number(result.avgPrice) : NaN,
        };
    }

    async finalizeOrderResult(result) {
        return result;
    }

    orderFailureDisposition(error, { attempt = 1 } = {}) {
        if (error instanceof HyperliquidError) {
            if (error.status === 429) return { action: 'retry', delayMs: attempt === 1 ? 1000 : 3000 };
            if (error.status >= 400 && error.status < 500) return { action: 'reject' };
        }
        return { action: 'ambiguous' };
    }

    async fillsFor(oid, aroundTime) {
        const fills = await this.info({
            type: 'userFillsByTime', user: this.user,
            startTime: Math.max(0, aroundTime - 5 * 60000), endTime: aroundTime + 5 * 60000,
        }, 20 + 5);
        let qty = 0, quote = 0;
        for (const f of Array.isArray(fills) ? fills : []) {
            if (Number(f.oid) !== Number(oid)) continue;
            qty += Number(f.sz);
            quote += Number(f.sz) * Number(f.px);
        }
        return qty > 0 ? { qty, avgPx: quote / qty } : null;
    }

    async resolvePendingOrder(row) {
        const cloid = row?.client_order_id;
        const symbol = row?.symbol;
        if (!cloid || !symbol) return { outcome: 'unknown', reason: 'the order was journalled without a client order id' };
        let found;
        try {
            found = await this.info({ type: 'orderStatus', user: this.user, oid: cloid }, 2);
        } catch (err) {
            return { outcome: 'unknown', reason: err.message };
        }
        if (found?.status === 'unknownOid') return { outcome: 'rejected', reason: 'the venue has no record of this order' };
        const order = found?.order?.order;
        if (!order) return { outcome: 'unknown', reason: `unexpected orderStatus reply: ${JSON.stringify(found).slice(0, 200)}` };
        let fill;
        try {
            fill = await this.fillsFor(order.oid, Number(found.order.statusTimestamp || order.timestamp || row.ts));
        } catch (err) {
            return { outcome: 'unknown', reason: err.message };
        }
        if (!fill) return { outcome: 'rejected', response: found, reason: `the venue reports this order as ${found.order.status}` };
        const response = {
            symbol, clientOrderId: cloid, orderId: order.oid, status: 'FILLED',
            executedQty: String(fill.qty), avgPrice: String(fill.avgPx), venueStatus: found.order.status,
        };
        return { outcome: 'filled', response, parsed: this.parseOrderResult(response) };
    }

    async maxLeverageFor(symbol) {
        if (!this.symbolRules.size) await this.loadMeta();
        return this.symbolRules.get(symbol)?.maxLeverage ?? null;
    }

    async setLeverage(symbol, leverage) {
        const r = this.symbolRules.get(symbol);
        if (!r) throw new Error(`No Hyperliquid rules for ${symbol}`);
        await this.exchange({ type: 'updateLeverage', asset: r.asset, isCross: true, leverage: Math.trunc(leverage) });
        return Math.trunc(leverage);
    }

    async getIncome({ startTime, endTime = this.now() } = {}) {
        const out = [];
        let from = startTime;
        for (let page = 0; page < 100; page++) {
            const rows = await this.info({ type: 'userFunding', user: this.user, startTime: from, endTime }, 20 + 25);
            if (!Array.isArray(rows) || !rows.length) break;
            out.push(...rows);
            const last = Number(rows.at(-1).time);
            if (rows.length < 500 || !(last > from)) break;
            from = last + 1;
        }
        return out.map(row => ({
            id: `FUNDING_FEE:${row.hash}:${row.delta?.coin || ''}`,
            time: Number(row.time),
            symbol: row.delta?.coin || null,
            type: 'FUNDING_FEE',
            amount: Number(row.delta?.usdc),
            asset: 'USDC',
            info: row.delta?.fundingRate ?? null,
            tradeId: null,
        }));
    }
}
