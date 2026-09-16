import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Strategy from '../backtest/strategy.js';
import { intervalMsMap } from '../backtest/consts.js';

async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    }));
    return out;
}

export function splitPositionOrder(currentQty, signedQty) {
    if (!(signedQty !== 0) || !Number.isFinite(signedQty)) return [];
    if (!currentQty || Math.sign(currentQty) === Math.sign(signedQty)) {
        return [{ signedQty, reduceOnly: false }];
    }
    const closing = Math.min(Math.abs(currentQty), Math.abs(signedQty));
    const out = [{ signedQty: -Math.sign(currentQty) * closing, reduceOnly: true }];
    const remainder = Math.abs(signedQty) - closing;
    if (remainder > 1e-12) out.push({ signedQty: Math.sign(signedQty) * remainder, reduceOnly: false });
    return out;
}

export default class ForwardRunner {
    constructor({
        strategy,
        broker,
        warmupBars = 30 * 96,
        stateFile = 'output/forward-state.json',
        stateIdentity = 'forward-v1',
        concurrency = 16,
        symbolRefreshMs = 3600000,
        streamGraceMs = 5000,
        maxMissingFraction = 0.02,
        streamFactory = null,
        dryRun = false,
        capitalLimit = Infinity,
        maxGross = 1.10,
        maxAbsNet = 0.15,
        maxOrderNotional = 10000,
        symbols = null,
        logger = console,
    }) {
        if (!(strategy instanceof Strategy)) throw new TypeError('strategy must be a Strategy');
        const methods = [
            'initialize', 'getTradableSymbols', 'getPortfolio', 'getHistory',
            'getClosedCandle', 'createStream', 'normalizeQuantity', 'placeMarketOrder',
        ];
        const missing = methods.filter(method => typeof broker?.[method] !== 'function');
        if (missing.length) {
            throw new TypeError(`broker does not implement the forward contract: ${missing.join(', ')}`);
        }
        const intervalNames = Object.keys(strategy.intervals);
        if (intervalNames.length !== 1) throw new Error('ForwardRunner currently supports one strategy interval');
        this.strategy = strategy;
        this.broker = broker;
        this.interval = strategy.mainInterval.name;
        this.stepMs = intervalMsMap[this.interval];
        this.warmupBars = warmupBars;
        this.stateFile = stateFile;
        this.stateIdentity = stateIdentity;
        this.concurrency = concurrency;
        this.symbolRefreshMs = symbolRefreshMs;
        this.streamGraceMs = streamGraceMs;
        this.maxMissingFraction = maxMissingFraction;
        this.streamFactory = streamFactory;
        this.dryRun = dryRun;
        this.capitalLimit = capitalLimit;
        this.maxGross = maxGross;
        this.maxAbsNet = maxAbsNet;
        this.maxOrderNotional = maxOrderNotional;
        this.fixedSymbols = symbols ? [...symbols].sort() : null;
        this.logger = logger;

        this.symbols = [];
        this.buffers = new Map();
        this.stockBalances = {};
        this.stockPrices = {};
        this.cashBalance = 0;
        this.equity = 0;
        this.availableBalance = 0;
        this.intents = [];
        this.lastSymbolRefresh = 0;
        this.stopped = false;
        this.stream = null;
        this.state = this.readState();
        this.ctx = {
            stockBalances: this.stockBalances,
            stockPrices: this.stockPrices,
            cashBalance: this.cashBalance,
            totalValue: () => this.strategyEquity(),
            grossExposure: () => this.grossExposure(),
        };
    }

    readState() {
        if (!this.stateFile || !existsSync(this.stateFile)) {
            return { identity: this.stateIdentity, lastProcessedBar: 0, status: 'new' };
        }
        try {
            const state = JSON.parse(readFileSync(this.stateFile, 'utf8'));
            if (state.identity && state.identity !== this.stateIdentity) {
                throw new Error(`state belongs to ${state.identity}, expected ${this.stateIdentity}`);
            }
            return { identity: this.stateIdentity, ...state };
        } catch (err) {
            throw new Error(`Cannot read forward state ${this.stateFile}: ${err.message}`);
        }
    }

    writeState(patch) {
        if (!this.stateFile) return;
        this.state = { ...this.state, identity: this.stateIdentity, ...patch, updatedAt: new Date().toISOString() };
        mkdirSync(dirname(this.stateFile), { recursive: true });
        const tmp = `${this.stateFile}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.state, null, 2));
        renameSync(tmp, this.stateFile);
    }

    grossExposure() {
        let gross = 0;
        for (const [symbol, qty] of Object.entries(this.stockBalances)) {
            const px = this.stockPrices[symbol];
            if (px > 0) gross += Math.abs(qty * px);
        }
        return gross;
    }

    strategyEquity() {
        return Math.min(this.equity, this.capitalLimit);
    }

    async refreshAccount() {
        const portfolio = await this.broker.getPortfolio();
        this.cashBalance = Number(portfolio.cash ?? 0);
        this.availableBalance = Number(portfolio.available ?? 0);
        this.equity = Number(portfolio.equity ?? 0);
        for (const key of Object.keys(this.stockBalances)) delete this.stockBalances[key];
        for (const p of portfolio.positions || []) {
            const qty = Number(p.quantity);
            if (qty) this.stockBalances[p.symbol] = qty;
            const mark = Number(p.markPrice);
            if (mark > 0) this.stockPrices[p.symbol] = mark;
        }
        this.ctx.cashBalance = this.cashBalance;
    }

    async refreshSymbols(force = false) {
        if (!force && Date.now() - this.lastSymbolRefresh < this.symbolRefreshMs) return [];
        const next = this.fixedSymbols || await this.broker.getTradableSymbols();
        const before = new Set(this.symbols);
        this.symbols = [...next].sort();
        const available = new Set(this.symbols);
        const missingHeld = Object.keys(this.stockBalances).filter(s => this.stockBalances[s] && !available.has(s));
        if (missingHeld.length) throw new Error(`Held symbols are absent from the executable universe: ${missingHeld.join(', ')}`);
        this.lastSymbolRefresh = Date.now();
        const added = this.symbols.filter(s => !before.has(s));
        for (const s of added) if (!this.buffers.has(s)) this.buffers.set(s, []);
        this.stream?.setSymbols(this.symbols);
        if (before.size && added.length) this.logger.log(`ForwardRunner: discovered ${added.length} new symbols`);
        return added;
    }

    addCandle(symbol, candle) {
        this.stockPrices[symbol] = candle.close;
        const buffer = this.buffers.get(symbol) || [];
        const last = buffer.at(-1);
        if (!last || last.timestamp < candle.timestamp) buffer.push(candle);
        else if (last.timestamp === candle.timestamp) buffer[buffer.length - 1] = candle;
        const keep = Math.max(this.warmupBars + 2, this.strategy.mainInterval.count + 2);
        if (buffer.length > keep) buffer.splice(0, buffer.length - keep);
        this.buffers.set(symbol, buffer);
    }

    stockView(symbol, candle) {
        const enqueue = (signedQty, price) => {
            if (!(Math.abs(signedQty) > 0) || !Number.isFinite(signedQty) || !(price > 0)) {
                throw new Error(`Invalid order intent for ${symbol}`);
            }
            this.intents.push({ symbol, signedQty, price });
        };
        return {
            stockName: symbol,
            candle,
            stockBalance: this.stockBalances[symbol] || 0,
            features: null,
            setFeatures() {},
            getCandles: (interval, count) => {
                if (interval !== this.interval) throw new Error(`Forward interval ${interval} is not loaded`);
                return (this.buffers.get(symbol) || []).slice(-count).reverse();
            },
            buy: (quantity, price) => enqueue(quantity, price),
            sell: (quantity, price) => enqueue(-quantity, price),
        };
    }

    async tick(timestamp, candles, { execute = true } = {}) {
        if (execute && timestamp <= Number(this.state.lastProcessedBar || 0)) return { skipped: true, intents: [] };
        if (execute) await this.refreshAccount();
        this.intents = [];
        for (const { symbol, candle } of candles) this.addCandle(symbol, candle);
        const stocks = candles.map(({ symbol, candle }) => this.stockView(symbol, candle));
        this.ctx.isWarmup = !execute;
        try {
            await this.strategy.onTick({ stocks, currentDate: new Date(timestamp), ctx: this.ctx, raw: null });
        } finally {
            this.ctx.isWarmup = false;
        }
        const intents = this.intents.slice();
        if (!execute) {
            if (intents.length) throw new Error(`Strategy generated ${intents.length} orders during warm-up at ${new Date(timestamp).toISOString()}`);
            return { skipped: false, intents };
        }
        this.validateBatch(intents);
        this.writeState({ lastProcessedBar: timestamp, status: 'executing', intentCount: intents.length });
        const fills = this.dryRun ? [] : await this.executeBatch(timestamp, intents);
        if (!this.dryRun) await this.refreshAccount();
        this.writeState({ lastProcessedBar: timestamp, status: this.dryRun ? 'dry-run' : 'complete', intentCount: intents.length });
        return { skipped: false, intents, fills };
    }

    validateBatch(intents) {
        const sizingEquity = this.strategyEquity();
        if (!(sizingEquity > 0)) throw new Error('Broker account equity is not positive');
        const projected = { ...this.stockBalances };
        for (const intent of intents) {
            const current = projected[intent.symbol] || 0;
            for (const leg of splitPositionOrder(current, intent.signedQty)) {
                if (!leg.reduceOnly && Math.abs(leg.signedQty * intent.price) > this.maxOrderNotional) {
                    throw new Error(`${intent.symbol} opening order exceeds $${this.maxOrderNotional} safety cap`);
                }
            }
            projected[intent.symbol] = current + intent.signedQty;
        }
        let gross = 0, net = 0;
        for (const [symbol, qty] of Object.entries(projected)) {
            const px = this.stockPrices[symbol];
            if (!(px > 0)) continue;
            gross += Math.abs(qty * px);
            net += qty * px;
        }
        if (gross > this.maxGross * sizingEquity) {
            throw new Error(`Projected gross ${(gross / sizingEquity).toFixed(2)}x exceeds ${this.maxGross.toFixed(2)}x cap`);
        }
        if (Math.abs(net) > this.maxAbsNet * sizingEquity) {
            throw new Error(`Projected net ${(net / sizingEquity).toFixed(2)}x exceeds ${this.maxAbsNet.toFixed(2)}x cap`);
        }
    }

    async executeBatch(timestamp, intents) {
        const fills = [];
        const projected = { ...this.stockBalances };
        let sequence = 0;
        for (const intent of intents) {
            const current = projected[intent.symbol] || 0;
            for (const leg of splitPositionOrder(current, intent.signedQty)) {
                const quantity = this.broker.normalizeQuantity(intent.symbol, leg.signedQty, intent.price, { reduceOnly: leg.reduceOnly });
                if (!quantity) {
                    this.logger.warn(`ForwardRunner: skipped sub-minimum order ${intent.symbol}`);
                    continue;
                }
                const signedRounded = Math.sign(leg.signedQty) * Number(quantity);
                const idParts = { timestamp, symbol: intent.symbol, sequence: sequence++ };
                const clientOrderId = this.broker.createClientOrderId?.(idParts)
                    || `fw-${timestamp.toString(36)}-${intent.symbol}-${idParts.sequence}`;
                try {
                    const fill = await this.broker.placeMarketOrder({
                        symbol: intent.symbol,
                        side: signedRounded > 0 ? 'buy' : 'sell',
                        quantity,
                        reduceOnly: leg.reduceOnly,
                        clientOrderId,
                    });
                    fills.push(fill);
                    projected[intent.symbol] = (projected[intent.symbol] || 0) + signedRounded;
                } catch (err) {
                    await this.refreshAccount();
                    throw new Error(`Order batch stopped after ${fills.length} fills: ${err.message}`, { cause: err });
                }
            }
        }
        return fills;
    }

    async preload() {
        this.logger.log(`ForwardRunner: loading ${this.warmupBars} ${this.interval} bars for ${this.symbols.length} symbols`);
        const endTime = typeof this.broker.now === 'function' ? this.broker.now() : Date.now();
        const historiesRaw = await pool(this.symbols, this.concurrency,
            symbol => this.broker.getHistory(symbol, this.interval, this.warmupBars, { endTime, stepMs: this.stepMs }));
        const histories = historiesRaw.map((candles, i) => ({ symbol: this.symbols[i], candles, at: 0 }));
        const times = new Set();
        for (const history of histories) for (const candle of history.candles) times.add(candle.timestamp);
        const sortedTimes = [...times].sort((a, b) => a - b);
        for (const timestamp of sortedTimes) {
            const candles = [];
            for (const history of histories) {
                while (history.at < history.candles.length && history.candles[history.at].timestamp < timestamp) history.at++;
                if (history.at < history.candles.length && history.candles[history.at].timestamp === timestamp) {
                    candles.push({ symbol: history.symbol, candle: history.candles[history.at++] });
                }
            }
            if (candles.length) await this.tick(timestamp, candles, { execute: false });
        }
        const latest = sortedTimes.at(-1) || 0;
        this.logger.log(`ForwardRunner: warm-up complete through ${latest ? new Date(latest).toISOString() : 'n/a'}`);
        return latest;
    }

    async fetchClosedBatch(timestamp, symbols = this.symbols) {
        const got = await pool(symbols, this.concurrency, async symbol => {
            const candle = await this.broker.getClosedCandle(symbol, this.interval, timestamp, { stepMs: this.stepMs });
            return candle ? { symbol, candle } : null;
        });
        return got.filter(Boolean);
    }

    async initialize() {
        await this.broker.initialize();
        await this.refreshSymbols(true);
        await this.refreshAccount();
        const createStream = this.streamFactory || (opts => this.broker.createStream(opts));
        this.stream = createStream({
            symbols: this.symbols,
            interval: this.interval,
            stepMs: this.stepMs,
            graceMs: this.streamGraceMs,
            logger: this.logger,
        });
        await this.stream.start();
        return this.preload();
    }

    async stop() {
        this.stopped = true;
        await this.stream?.stop();
    }

    async recoverMissing(batch) {
        if (!batch.missing.length) return batch.candles;
        const recovered = await this.fetchClosedBatch(batch.timestamp, batch.missing);
        const got = new Set(recovered.map(x => x.symbol));
        const stillMissing = batch.missing.filter(s => !got.has(s));
        if (stillMissing.length / Math.max(1, batch.expected) > this.maxMissingFraction) {
            throw new Error(`Market-data batch ${new Date(batch.timestamp).toISOString()} remains incomplete: ${stillMissing.length}/${batch.expected} symbols missing after history recovery`);
        }
        if (stillMissing.length) this.logger.warn(`ForwardRunner: ${stillMissing.length} inactive symbols omitted after history recovery`);
        return [...batch.candles, ...recovered];
    }

    async recoverGap(afterTimestamp, beforeTimestamp) {
        for (let timestamp = afterTimestamp + this.stepMs; timestamp < beforeTimestamp; timestamp += this.stepMs) {
            this.logger.warn(`ForwardRunner: recovering missed bar ${new Date(timestamp).toISOString()} from history`);
            const candles = await this.fetchClosedBatch(timestamp);
            if (!candles.length) throw new Error(`No candles available for missed bar ${new Date(timestamp).toISOString()}`);
            await this.tick(timestamp, candles, { execute: true });
        }
    }

    async run() {
        try {
            const latestWarmup = await this.initialize();
            if (this.state.status === 'executing') {
                this.logger.warn(`ForwardRunner: previous process stopped during bar ${this.state.lastProcessedBar}; it will not be replayed`);
            }
            let last = Math.max(latestWarmup, Number(this.state.lastProcessedBar || 0));
            const brokerLabel = this.broker.label || 'broker';
            this.logger.log(`ForwardRunner: ${brokerLabel}${this.dryRun ? ' dry-run' : ''} stream; live after ${new Date(last).toISOString()}`);
            while (!this.stopped) {
                const batch = await this.stream.nextBatch();
                if (!batch) break;
                await this.refreshSymbols();
                if (batch.timestamp <= last) continue;
                if (batch.timestamp > last + this.stepMs) await this.recoverGap(last, batch.timestamp);
                const candles = await this.recoverMissing(batch);
                const result = await this.tick(batch.timestamp, candles, { execute: true });
                last = batch.timestamp;
                this.logger.log(`ForwardRunner: ${new Date(last).toISOString()} ${candles.length}/${batch.expected} streamed candles, ${result.intents.length} intents, ${result.fills?.length || 0} fills`);
            }
        } finally {
            await this.stream?.stop();
        }
    }
}
