import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Broker from './base.js';
import Candle from '../backtest/candle.js';
import BinanceKlineStream from './binanceKlineStream.js';

const PROD_REST = 'https://fapi.binance.com';
const DEMO_REST = 'https://demo-fapi.binance.com';
const DEFAULT_FILL_PRICE_RETRY_DELAYS_MS = Object.freeze([0, 50, 150, 400, 1000, 2500, 5000]);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const hasFillPrice = (order) => Number(order?.avgPrice) > 0 || Number(order?.cumQuote) > 0;

function parseBinanceJson(raw) {
    const preciseOrderIds = raw.replace(
        /(\"orderId\"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g,
        '$1"$2"',
    );
    return JSON.parse(preciseOrderIds);
}

function fillPriceLookupError(err) {
    return {
        status: err?.status ?? null,
        code: err?.code ?? null,
        message: err?.message || String(err),
    };
}

const usableOrderId = (orderId) => (
    typeof orderId === 'string' && orderId !== '' ? orderId
        : Number.isSafeInteger(orderId) ? orderId : null);

function fillPriceFromTrades(trades, orderId) {
    const wanted = orderId == null ? null : String(orderId);
    let quantity = 0;
    let quote = 0;
    let count = 0;
    for (const trade of Array.isArray(trades) ? trades : []) {
        if (wanted != null && String(trade?.orderId) !== wanted) continue;
        const qty = Number(trade?.qty);
        const price = Number(trade?.price);
        const quoted = Number(trade?.quoteQty);
        if (!(qty > 0) || !(price > 0)) continue;
        quantity += qty;
        quote += quoted > 0 ? quoted : qty * price;
        count++;
    }
    if (!(quantity > 0) || !(quote > 0)) return null;
    return { avgPrice: String(quote / quantity), cumQuote: String(quote), fillCount: count };
}

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

export function rowToClosedCandle(row, stepMs) {
    return new Candle(
        Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]),
        Number(row[5]), Number(row[0]) + stepMs, Number(row[7]),
    );
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
        apiKey = null,
        apiSecret = null,
        marketDataBaseUrl = PROD_REST,
        demoBaseUrl = DEMO_REST,
        liveBaseUrl = PROD_REST,
        webSocketUrl,
        webSocketImpl = globalThis.WebSocket,
        recvWindow = 5000,
        timeoutMs = 15000,
        maxRequestWeightPerMinute = 1800,
        fetchImpl = globalThis.fetch,
        strictQuantization = false,
        exchangeInfoCachePath = 'data/binance/exchangeInfo.json',
        exchangeInfoMaxAgeMs = 7 * 86400000,
        fillPriceRetryDelaysMs = DEFAULT_FILL_PRICE_RETRY_DELAYS_MS,
    } = {}) {
        super();
        if (!['demo', 'live'].includes(environment)) {
            throw new TypeError("environment must be 'demo' or 'live'");
        }
        if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');

        this.market = 'crypto';
        this.feeBps = feeBps;
        this.slippage = slippage;
        this.impactCoef = impactCoef;
        this.depthRatio = depthRatio;
        this.environment = environment;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.marketDataBaseUrl = marketDataBaseUrl.replace(/\/$/, '');
        this.tradeBaseUrl = (environment === 'demo' ? demoBaseUrl : liveBaseUrl).replace(/\/$/, '');
        this.webSocketUrl = webSocketUrl;
        this.webSocketImpl = webSocketImpl;
        this.recvWindow = recvWindow;
        this.timeoutMs = timeoutMs;
        this.fetchImpl = fetchImpl;
        this.timeOffsetMs = 0;
        this.symbolRules = new Map();
        this.marketSymbols = new Set();
        this.unquantizedSymbols = new Set();
        this.strictQuantization = strictQuantization;
        this.exchangeInfoCachePath = exchangeInfoCachePath;
        this.exchangeInfoMaxAgeMs = exchangeInfoMaxAgeMs;
        this.fillPriceRetryDelaysMs = [...fillPriceRetryDelaysMs];
        this.limiter = new MinuteWeightLimiter(maxRequestWeightPerMinute);
    }

    get isDemo() { return this.environment === 'demo'; }

    get label() {
        return `Binance Futures ${this.environment}`;
    }

    get dataSource() {
        return `binance-futures-${new URL(this.marketDataBaseUrl).host}`;
    }

    get account() {
        const suffix = this.apiKey ? `-${createHash('sha256').update(this.apiKey).digest('hex').slice(0, 10)}` : '';
        return `binance-futures-${this.environment}${suffix}`;
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

    get tradingMode() {
        return this.environment === 'demo' ? 'demo' : 'live';
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

    now() {
        return Date.now() + Number(this.timeOffsetMs || 0);
    }

    async request(path, {
        method = 'GET', params = {}, signed = false, weight = 1,
        trade = signed, retry = !signed && method === 'GET',
    } = {}) {
        const { apiKey, apiSecret } = this;
        if (signed && (!apiKey || !apiSecret)) {
            throw new Error(`Binance Futures ${this.environment} requests need apiKey and apiSecret`);
        }
        await this.limiter.acquire(weight);

        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) query.set(key, String(value));
        }
        if (signed) {
            query.set('timestamp', String(Date.now() + this.timeOffsetMs));
            query.set('recvWindow', String(this.recvWindow));
            query.set('signature', createHmac('sha256', apiSecret).update(query.toString()).digest('hex'));
        }

        const base = trade ? this.tradeBaseUrl : this.marketDataBaseUrl;
        const url = `${base}${path}${query.size ? `?${query}` : ''}`;
        const headers = signed ? { 'X-MBX-APIKEY': apiKey } : {};
        const attempts = retry ? 4 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const res = await this.fetchImpl(url, { method, headers, signal: controller.signal });
                const raw = await res.text();
                let body;
                try { body = raw ? parseBinanceJson(raw) : {}; } catch { body = raw; }
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
        this.applyExchangeRules(execution);
        return { market, execution };
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

    async fetchIncome({ startTime, endTime, limit = 1000 } = {}) {
        return this.request('/fapi/v1/income', { signed: true, params: { startTime, endTime, limit }, weight: 30 });
    }

    async initialize() {
        await this.syncTime();
        const mode = await this.getPositionMode();
        if (mode.dualSidePosition === true) {
            throw new Error('Binance Futures forward trading requires one-way position mode');
        }
        await this.loadExchangeInfo();
    }

    async excludedSymbols() {
        if (!this.excludedSymbolSet) {
            const market = await this.request('/fapi/v1/exchangeInfo');
            this.excludedSymbolSet = new Set((market.symbols || [])
                .filter(s => s.contractType !== 'PERPETUAL' || s.quoteAsset !== 'USDT')
                .map(s => s.symbol));
        }
        return this.excludedSymbolSet;
    }

    async getTradableSymbols() {
        await this.loadExchangeInfo();
        return [...this.symbolRules]
            .filter(([symbol, r]) => this.marketSymbols.has(symbol)
                && r.status === 'TRADING' && r.contractType === 'PERPETUAL' && r.quoteAsset === 'USDT')
            .map(([symbol]) => symbol)
            .sort();
    }

    async getPortfolio() {
        const [account, positions] = await Promise.all([this.getAccount(), this.getPositions()]);
        return {
            cash: Number(account.availableBalance ?? account.totalWalletBalance ?? 0),
            available: Number(account.availableBalance ?? 0),
            equity: Number(account.totalMarginBalance ?? account.totalWalletBalance ?? 0),
            positions: (positions || []).map(position => ({
                symbol: position.symbol,
                quantity: Number(position.positionAmt),
                markPrice: Number(position.markPrice),
                entryPrice: Number(position.entryPrice),
                unrealizedPnl: Number(position.unRealizedProfit),
            })),
        };
    }

    async getHistory(symbol, interval, bars, { endTime = this.now(), stepMs } = {}) {
        const rows = await this.getKlineHistory(symbol, interval, bars, { endTime });
        return rows.map(row => rowToClosedCandle(row, stepMs));
    }

    async getClosedCandle(symbol, interval, timestamp, { stepMs } = {}) {
        const rows = await this.getKlines(symbol, interval, { endTime: timestamp, limit: 2 });
        const row = rows.find(candidate => Number(candidate[0]) + stepMs === timestamp
            && Number(candidate[6]) < this.now());
        return row ? rowToClosedCandle(row, stepMs) : null;
    }

    createStream({ symbols, interval, stepMs, graceMs, logger }) {
        return new BinanceKlineStream({
            symbols, interval, stepMs, graceMs, logger,
            webSocketImpl: this.webSocketImpl,
            ...(this.webSocketUrl ? { url: this.webSocketUrl } : {}),
        });
    }

    quantize(symbol, signedQty, price, { reduceOnly = false } = {}) {
        const r = this.symbolRules.get(symbol);
        if (!r) {
            if (this.strictQuantization) throw new Error(`No Binance Futures exchange rules for ${symbol}`);
            this.unquantizedSymbols.add(symbol);
            return signedQty;
        }
        const step = r.stepSize;
        const rounded = Math.floor((Math.abs(signedQty) + step * 1e-9) / step) * step;
        if (!(rounded >= r.minQty) || rounded > r.maxQty) return 0;
        if (!reduceOnly && price > 0 && rounded * price < r.minNotional) return 0;
        return Math.sign(signedQty) * rounded;
    }

    normalizeQuantity(symbol, quantity, price, { reduceOnly = false } = {}) {
        if (!this.symbolRules.has(symbol)) throw new Error(`No Binance Futures exchange rules for ${symbol}`);
        const signed = this.quantize(symbol, quantity, price, { reduceOnly });
        if (!signed) return null;
        return Math.abs(signed).toFixed(decimalsFor(this.symbolRules.get(symbol).stepSize));
    }

    async prepareBacktest() {
        if (this.symbolRules.size) return;
        const path = this.exchangeInfoCachePath;
        const maxAgeMs = this.exchangeInfoMaxAgeMs;
        let info = null;
        try {
            const stat = statSync(path);
            if (Date.now() - stat.mtimeMs < maxAgeMs) info = JSON.parse(readFileSync(path, 'utf8'));
        } catch {}
        if (!info) {
            const res = await fetch(`${PROD_REST}/fapi/v1/exchangeInfo`);
            if (!res.ok) throw new BinanceFuturesError(`exchangeInfo failed: HTTP ${res.status}`, { status: res.status });
            info = await res.json();
            try {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, JSON.stringify(info));
            } catch {}
        }
        this.applyExchangeRules(info);
        return this.symbolRules.size;
    }

    applyExchangeRules(info) {
        this.symbolRules.clear();
        for (const s of info.symbols || []) {
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
        return this.symbolRules;
    }

    async placeMarketOrder({ symbol, side, quantity, reduceOnly = false, clientOrderId }) {
        if (!['buy', 'sell'].includes(side)) throw new TypeError('side must be buy or sell');
        const placed = await this.request('/fapi/v1/order', {
            method: 'POST',
            signed: true,
            params: {
                symbol, side: side === 'buy' ? 'BUY' : 'SELL', type: 'MARKET', quantity,
                reduceOnly: reduceOnly ? 'true' : undefined,
                newClientOrderId: clientOrderId,
                newOrderRespType: 'RESULT',
            },
            retry: false,
        });
        return this.withFillPrice(placed);
    }

    async withFillPrice(order, { retryDelaysMs = this.fillPriceRetryDelaysMs } = {}) {
        if (!order || typeof order !== 'object') return order;
        if (hasFillPrice(order)) return order;
        if (String(order.status).toUpperCase() !== 'FILLED') return order;

        const delays = retryDelaysMs?.length
            ? retryDelaysMs
            : DEFAULT_FILL_PRICE_RETRY_DELAYS_MS;
        let orderLastError = null;
        let orderAttempts = 0;
        let tradeLastError = null;
        let tradeAttempts = 0;
        for (const delay of delays) {
            if (delay > 0) await sleep(delay);
            orderAttempts++;
            let lookupOrder = order;
            try {
                const found = await this.fetchOrder(usableOrderId(order.orderId) != null
                    ? { symbol: order.symbol, orderId: usableOrderId(order.orderId) }
                    : { symbol: order.symbol, clientOrderId: order.clientOrderId });
                if (hasFillPrice(found)) {
                    return { ...order, ...found, fillPriceSource: 'order' };
                }
                lookupOrder = { ...order, ...found };
                orderLastError = { status: null, code: null, message: 'order lookup returned no fill price' };
            } catch (err) {
                orderLastError = fillPriceLookupError(err);
            }

            try {
                tradeAttempts++;
                const trades = await this.fetchOrderTrades({
                    symbol: lookupOrder.symbol,
                    orderId: lookupOrder.orderId,
                    updateTime: lookupOrder.updateTime,
                    widenIfEmpty: true,
                });
                const price = fillPriceFromTrades(trades, lookupOrder.orderId);
                if (price) {
                    return { ...lookupOrder, ...price, fillPriceSource: 'userTrades' };
                }
                tradeLastError = {
                    status: null,
                    code: null,
                    message: 'account trade lookup returned no matching fills',
                };
            } catch (err) {
                tradeLastError = fillPriceLookupError(err);
            }
        }

        return {
            ...order,
            fillPriceLookup: {
                orderAttempts,
                tradeAttempts,
                lookupKey: usableOrderId(order.orderId) != null ? 'orderId' : 'origClientOrderId',
                orderLastError,
                tradeLastError,
            },
        };
    }

    async fetchOrder({ symbol, clientOrderId, orderId }) {
        return this.request('/fapi/v1/order', {
            method: 'GET',
            signed: true,
            params: { symbol, origClientOrderId: clientOrderId, orderId },
        });
    }

    async fetchOrderTrades({ symbol, orderId, updateTime, widenIfEmpty = false }) {
        const exactOrderId = usableOrderId(orderId);
        const time = Number(updateTime);
        const byTime = () => ({
            symbol,
            startTime: Number.isFinite(time) ? Math.max(0, time - 60000) : undefined,
            endTime: Number.isFinite(time) ? Math.min(this.now(), time + 60000) : undefined,
            limit: 1000,
        });
        const ask = (params) => this.request('/fapi/v1/userTrades', { signed: true, params, weight: 5 });

        if (exactOrderId == null) return ask(byTime());
        const found = await ask({ symbol, orderId: exactOrderId, limit: 1000 });
        if (!widenIfEmpty || (Array.isArray(found) && found.length)) return found;
        return ask(byTime());
    }

    parseOrderResult(result) {
        if (!result || typeof result !== 'object') return {};
        const executedQty = Number(result.executedQty);
        const quote = Number(result.cumQuote ?? result.cummulativeQuoteQty);
        const average = Number(result.avgPrice);
        return {
            exchangeOrderId: result.orderId,
            status: result.status,
            executedQty,
            avgPrice: average > 0 ? average
                : (quote > 0 && executedQty > 0 ? quote / executedQty : NaN),
        };
    }

    async backfillOrderResult(row) {
        const original = row?.response && typeof row.response === 'object' ? row.response : {};
        return this.withFillPrice({
            ...original,
            symbol: row.symbol,
            status: 'FILLED',
            clientOrderId: row.client_order_id || original.clientOrderId,
            orderId: row.exchange_order_id || original.orderId,
            updateTime: original.updateTime || row.ts,
            executedQty: original.executedQty || row.executed_qty || row.quantity,
        }, { retryDelaysMs: [0] });
    }

    async getTradingStatus() {
        const permissions = await this.request('/fapi/v1/apiTradingStatus', { signed: true });
        return permissions?.status ?? null;
    }

    async getIncome({ startTime, endTime = this.now() } = {}) {
        const out = [];
        let from = startTime;
        for (let page = 0; page < 100; page++) {
            const rows = await this.fetchIncome({ startTime: from, endTime, limit: 1000 });
            out.push(...rows);
            if (rows.length < 1000) break;
            const lastTime = Number(rows.at(-1).time);
            if (!(lastTime > from)) break;
            from = lastTime;
        }
        return out.map(row => ({
            id: `${row.incomeType}:${row.tranId}:${row.symbol || ''}:${row.asset || ''}`,
            time: Number(row.time),
            symbol: row.symbol || null,
            type: row.incomeType,
            amount: Number(row.income),
            asset: row.asset,
            info: row.info || null,
            tradeId: row.tradeId || null,
        }));
    }
}
