import { createHmac } from 'node:crypto';
import Broker from './base.js';

const PROD_REST = 'https://fapi.binance.com';
const DEMO_REST = 'https://demo-fapi.binance.com';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class BinanceFuturesError extends Error {
    constructor(message, { status = null, code = null, body = null } = {}) {
        super(message);
        this.name = 'BinanceFuturesError';
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

export function klineRequestWeight(limit) {
    if (limit < 100) return 1;
    if (limit < 500) return 2;
    if (limit <= 1000) return 5;
    return 10;
}

class MinuteWeightLimiter {
    constructor(maxWeight = 1800) {
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

const decimalsFor = (step) => {
    const s = String(step).toLowerCase();
    if (s.includes('e-')) return Number(s.split('e-')[1]);
    return (s.split('.')[1] || '').replace(/0+$/, '').length;
};

export default class BinanceFutures extends Broker {
    constructor({
        feeBps = 5,
        slippage = 0,
        impactCoef = 1,
        depthRatio = 0.5,
        environment = 'demo',
        allowLive = false,
        apiKey = null,
        apiSecret = null,
        marketDataBaseUrl = PROD_REST,
        demoBaseUrl = DEMO_REST,
        liveBaseUrl = PROD_REST,
        recvWindow = 5000,
        timeoutMs = 15000,
        maxRequestWeightPerMinute = 1800,
        fetchImpl = globalThis.fetch,
    } = {}) {
        super();
        if (!['demo', 'live'].includes(environment)) {
            throw new TypeError("environment must be 'demo' or 'live'");
        }
        if (environment === 'live' && allowLive !== true) {
            throw new Error('Live Binance Futures trading is locked; pass allowLive: true explicitly');
        }
        if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

        this.feeBps = feeBps;
        this.slippage = slippage;
        this.impactCoef = impactCoef;
        this.depthRatio = depthRatio;
        this.environment = environment;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.marketDataBaseUrl = marketDataBaseUrl.replace(/\/$/, '');
        this.tradeBaseUrl = (environment === 'demo' ? demoBaseUrl : liveBaseUrl).replace(/\/$/, '');
        this.recvWindow = recvWindow;
        this.timeoutMs = timeoutMs;
        this.fetchImpl = fetchImpl;
        this.timeOffsetMs = 0;
        this.symbolRules = new Map();
        this.marketSymbols = new Set();
        this.limiter = new MinuteWeightLimiter(maxRequestWeightPerMinute);
    }

    get isDemo() { return this.environment === 'demo'; }

    calculateFees(quantity, price, side, candle) {
        const notional = quantity * price;
        let fee = notional * (this.feeBps / 1e4 + this.slippage);
        if (this.impactCoef > 0 && candle && candle.quoteVolume > 0) {
            const frac = notional / (this.depthRatio * candle.quoteVolume);
            fee += notional * this.impactCoef * Math.min(0.05, (0.01 * frac) / 2);
        }
        return fee;
    }

    async request(path, {
        method = 'GET', params = {}, signed = false, weight = 1,
        trade = signed, retry = !signed && method === 'GET',
    } = {}) {
        if (signed && (!this.apiKey || !this.apiSecret)) {
            throw new Error(`Missing Binance Futures ${this.environment} API credentials`);
        }
        await this.limiter.acquire(weight);

        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) query.set(key, String(value));
        }
        if (signed) {
            query.set('timestamp', String(Date.now() + this.timeOffsetMs));
            query.set('recvWindow', String(this.recvWindow));
            query.set('signature', createHmac('sha256', this.apiSecret).update(query.toString()).digest('hex'));
        }

        const base = trade ? this.tradeBaseUrl : this.marketDataBaseUrl;
        const url = `${base}${path}${query.size ? `?${query}` : ''}`;
        const headers = signed ? { 'X-MBX-APIKEY': this.apiKey } : {};
        const attempts = retry ? 4 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const res = await this.fetchImpl(url, { method, headers, signal: controller.signal });
                const raw = await res.text();
                let body;
                try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; }
                if (res.ok) return body;
                const err = new BinanceFuturesError(
                    `Binance Futures ${method} ${path} failed: HTTP ${res.status}${body?.msg ? ` ${body.msg}` : ''}`,
                    { status: res.status, code: body?.code, body },
                );
                if (attempt + 1 >= attempts || (res.status !== 429 && res.status < 500)) throw err;
                await sleep(500 * 2 ** attempt);
            } catch (err) {
                if (attempt + 1 >= attempts || err instanceof BinanceFuturesError) throw err;
                await sleep(500 * 2 ** attempt);
            } finally {
                clearTimeout(timer);
            }
        }
        throw new Error('unreachable');
    }

    async syncTime() {
        const before = Date.now();
        const result = await this.request('/fapi/v1/time', { trade: true });
        const after = Date.now();
        this.timeOffsetMs = Number(result.serverTime) - Math.round((before + after) / 2);
        return this.timeOffsetMs;
    }

    async loadExchangeInfo() {
        const market = await this.request('/fapi/v1/exchangeInfo');
        const execution = this.tradeBaseUrl === this.marketDataBaseUrl
            ? market
            : await this.request('/fapi/v1/exchangeInfo', { trade: true });
        this.marketSymbols = new Set((market.symbols || [])
            .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
            .map(s => s.symbol));
        this.symbolRules.clear();
        for (const s of execution.symbols || []) {
            const lot = s.filters?.find(f => f.filterType === 'MARKET_LOT_SIZE')
                || s.filters?.find(f => f.filterType === 'LOT_SIZE');
            const minNotional = s.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
            this.symbolRules.set(s.symbol, {
                status: s.status,
                contractType: s.contractType,
                quoteAsset: s.quoteAsset,
                stepSize: Number(lot?.stepSize || 1),
                minQty: Number(lot?.minQty || 0),
                maxQty: Number(lot?.maxQty || Infinity),
                minNotional: Number(minNotional?.notional || minNotional?.minNotional || 0),
            });
        }
        return { market, execution };
    }

    async getTradableSymbols() {
        if (!this.symbolRules.size) await this.loadExchangeInfo();
        return [...this.symbolRules]
            .filter(([symbol, r]) => this.marketSymbols.has(symbol)
                && r.status === 'TRADING' && r.contractType === 'PERPETUAL' && r.quoteAsset === 'USDT')
            .map(([symbol]) => symbol)
            .sort();
    }

    async getKlines(symbol, interval, { startTime, endTime, limit = 1000 } = {}) {
        return this.request('/fapi/v1/klines', {
            params: { symbol, interval, startTime, endTime, limit },
            weight: klineRequestWeight(limit),
        });
    }

    async getKlineHistory(symbol, interval, bars, { endTime = Date.now() } = {}) {
        const out = [];
        let end = endTime;
        while (out.length < bars) {
            const limit = Math.min(1000, bars - out.length);
            const rows = await this.getKlines(symbol, interval, { endTime: end, limit });
            if (!rows.length) break;
            const complete = rows.filter(row => Number(row[6]) < endTime);
            out.unshift(...complete);
            const oldest = Number(rows[0][0]);
            if (!Number.isFinite(oldest) || oldest <= 0 || rows.length < limit) break;
            end = oldest - 1;
        }
        return out.slice(-bars);
    }

    async getAccount() {
        return this.request('/fapi/v2/account', { signed: true });
    }

    async getPositions() {
        return this.request('/fapi/v2/positionRisk', { signed: true });
    }

    async getPositionMode() {
        return this.request('/fapi/v1/positionSide/dual', { signed: true });
    }

    quantityFor(symbol, quantity, price, { reduceOnly = false } = {}) {
        const r = this.symbolRules.get(symbol);
        if (!r) throw new Error(`No Binance Futures exchange rules for ${symbol}`);
        const step = r.stepSize;
        const rounded = Math.floor((Math.abs(quantity) + step * 1e-9) / step) * step;
        if (!(rounded >= r.minQty) || rounded > r.maxQty) return null;
        if (!reduceOnly && price > 0 && rounded * price < r.minNotional) return null;
        return rounded.toFixed(decimalsFor(step));
    }

    async placeMarketOrder({ symbol, side, quantity, reduceOnly = false, clientOrderId }) {
        if (!['BUY', 'SELL'].includes(side)) throw new TypeError('side must be BUY or SELL');
        return this.request('/fapi/v1/order', {
            method: 'POST',
            signed: true,
            params: {
                symbol, side, type: 'MARKET', quantity,
                reduceOnly: reduceOnly ? 'true' : undefined,
                newClientOrderId: clientOrderId,
                newOrderRespType: 'RESULT',
            },
            retry: false,
        });
    }
}
