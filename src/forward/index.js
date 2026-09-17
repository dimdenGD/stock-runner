import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Strategy from '../backtest/strategy.js';
import Broker from '../brokers/base.js';
import { splitPositionOrder } from '../brokers/orderLegs.js';
import { intervalMsMap, markets } from '../backtest/consts.js';
import { formatSwapLine, formatTradeLine } from '../backtest/logFormat.js';
import ForwardJournal from './journal.js';
import TradeLedger from './tradeLedger.js';
import CandleCache from './candleCache.js';

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

export { splitPositionOrder };

const fileSafe = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');

export default class ForwardRunner {
    constructor({
        strategy,
        broker,
        capital,
        logs = {},
        market,
        allowShort,
        maxLeverage,
        maxNetExposure = Infinity,
        maxOrderNotional = Infinity,
        symbols = null,
        dryRun = false,
        dataDir = 'output/forward',
        logger = console,
        concurrency = 16,
        symbolRefreshMs = 3600000,
        streamGraceMs = 5000,
        streamHealthTimeoutMs = 15000,
        maxMissingFraction = 0.02,
        incomePollMs = 3600000,
        incomeLookbackMs = 7 * 86400000,
    }) {
        if (!(strategy instanceof Strategy)) throw new TypeError('strategy must be an instance of Strategy');
        if (!(broker instanceof Broker)) throw new TypeError('broker must be an instance of Broker');
        const missing = broker.missingForwardMethods();
        if (missing.length) {
            throw new TypeError(`${broker.label} does not support forward trading; missing ${missing.join(', ')}`);
        }
        if (typeof capital !== 'number' || !(capital > 0)) throw new TypeError('capital must be a positive number');
        if (Object.keys(strategy.intervals).length !== 1) throw new Error('ForwardRunner currently supports one strategy interval');
        market = market ?? broker.market ?? 'stocks';
        if (!markets.includes(market)) throw new TypeError(`market must be one of: ${markets.join(', ')}`);

        this.strategy = strategy;
        this.broker = broker;
        this.capital = capital;
        this.logs = { swaps: false, trades: false, ticks: false, ...logs };
        this.market = market;
        this.allowShort = allowShort ?? market === 'crypto';
        this.maxLeverage = maxLeverage ?? (market === 'crypto' ? 3 : 1);
        this.maxNetExposure = maxNetExposure;
        this.maxOrderNotional = maxOrderNotional;
        this.fixedSymbols = symbols ? [...symbols].sort() : null;
        this.dryRun = dryRun;
        this.logger = logger;
        this.concurrency = concurrency;
        this.symbolRefreshMs = symbolRefreshMs;
        this.streamGraceMs = streamGraceMs;
        this.streamHealthTimeoutMs = streamHealthTimeoutMs;
        this.maxMissingFraction = maxMissingFraction;
        this.incomePollMs = incomePollMs;
        this.incomeLookbackMs = incomeLookbackMs;

        this.interval = strategy.mainInterval.name;
        this.stepMs = intervalMsMap[this.interval];
        this.warmupBars = Math.max(strategy.warmup, strategy.mainInterval.count);
        this.dataDir = join(dataDir, strategy.name);
        this.stateFile = join(this.dataDir, `state-${fileSafe(broker.account)}${dryRun ? '-dry' : ''}.json`);
        this.journal = new ForwardJournal({ file: join(this.dataDir, 'journal.sqlite') });
        this.cache = new CandleCache({ file: join(dataDir, 'cache', fileSafe(broker.dataSource), `${this.interval}.sqlite`), stepMs: this.stepMs });
        this.lastPrune = 0;

        this.symbols = [];
        this.buffers = new Map();
        this.stockBalances = {};
        this.stockPrices = {};
        this.cashBalance = 0;
        this.equity = 0;
        this.availableBalance = 0;
        this.intents = [];
        this.pendingLogs = [];
        this.lastSymbolRefresh = 0;
        this.lastIncomePoll = 0;
        this.lastPortfolio = null;
        this.lastBatchInfo = {};
        this.currentTimestamp = null;
        this.runId = null;
        this.stopped = false;
        this.stream = null;
        this.state = this.readState();
        this.ledger = new TradeLedger(this.state.ledger);
        this.isWarmup = false;
        this.ctx = this;
    }

    readState() {
        if (!existsSync(this.stateFile)) return { lastProcessedBar: 0, status: 'new' };
        try {
            return JSON.parse(readFileSync(this.stateFile, 'utf8'));
        } catch (err) {
            throw new Error(`Cannot read forward state ${this.stateFile}: ${err.message}`);
        }
    }

    writeState(patch) {
        this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
        mkdirSync(dirname(this.stateFile), { recursive: true });
        const tmp = `${this.stateFile}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.state, null, 2));
        renameSync(tmp, this.stateFile);
    }

    totalValue() {
        return Math.min(this.equity, this.capital);
    }

    grossExposure() {
        let gross = 0;
        for (const [symbol, qty] of Object.entries(this.stockBalances)) {
            const px = this.stockPrices[symbol];
            if (px > 0) gross += Math.abs(qty * px);
        }
        return gross;
    }

    netExposure() {
        let net = 0;
        for (const [symbol, qty] of Object.entries(this.stockBalances)) {
            const px = this.stockPrices[symbol];
            if (px > 0) net += qty * px;
        }
        return net;
    }

    record(kind, data) {
        if (this.isWarmup || this.currentTimestamp == null) return;
        this.journal.record(this.runId, this.currentTimestamp, kind, data);
    }

    event(level, type, message, options) {
        this.journal.event(this.runId, level, type, message, options);
    }

    lastCandle(symbol) {
        return this.buffers.get(symbol)?.at(-1);
    }

    fee(symbol, quantity, price, side) {
        return Number(this.broker.calculateFees(quantity, price, side, this.lastCandle(symbol))) || 0;
    }

    snapshot(ts, phase) {
        this.journal.snapshot(this.runId, ts, phase, this.lastPortfolio, this.stockPrices);
    }

    flushTradeLogs() {
        const entries = this.pendingLogs;
        this.pendingLogs = [];
        for (const e of entries) {
            if (e.kind === 'swap' && this.logs.swaps) {
                this.logger.log(formatSwapLine({ ...e, cash: this.cashBalance, equity: this.equity }));
            } else if (e.kind === 'trade' && this.logs.trades) {
                this.logger.log(formatTradeLine({ ...e, market: this.market, cash: this.cashBalance, equity: this.equity }));
            }
        }
    }

    async pollIncome(force = false) {
        if (!force && Date.now() - this.lastIncomePoll < this.incomePollMs) return;
        this.lastIncomePoll = Date.now();
        try {
            const last = this.journal.lastIncomeTime(this.broker.account);
            const startTime = last != null ? last : Date.now() - this.incomeLookbackMs;
            const rows = await this.broker.getIncome({ startTime });
            if (!rows) return;
            const inserted = this.journal.income(this.broker.account, this.runId, rows);
            if (inserted) this.event('info', 'income', `${inserted} income rows`);
        } catch (err) {
            this.logger.warn(`ForwardRunner: income poll failed: ${err.message}`);
            this.event('warn', 'income-failed', err.message);
        }
    }

    async refreshAccount() {
        const portfolio = await this.broker.getPortfolio();
        this.lastPortfolio = portfolio;
        this.ledger.reconcile(portfolio.positions, (symbol, quantity, price) => this.fee(symbol, quantity, price, 'buy'));
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
        if (before.size && added.length) {
            this.logger.log(`ForwardRunner: discovered ${added.length} new symbols`);
            this.event('info', 'symbols-added', `${added.length} new symbols`, { data: added });
        }
        return added;
    }

    addCandle(symbol, candle) {
        this.stockPrices[symbol] = candle.close;
        const buffer = this.buffers.get(symbol) || [];
        const last = buffer.at(-1);
        if (!last || last.timestamp < candle.timestamp) buffer.push(candle);
        else if (last.timestamp === candle.timestamp) buffer[buffer.length - 1] = candle;
        const keep = this.strategy.mainInterval.count + 2;
        if (buffer.length > keep) buffer.splice(0, buffer.length - keep);
        this.buffers.set(symbol, buffer);
    }

    stockView(symbol, candle) {
        const enqueue = (signedQty, price) => {
            if (this.isWarmup) throw new Error(`Orders are not allowed during warm-up: ${symbol}`);
            if (!(Math.abs(signedQty) > 0) || !Number.isFinite(signedQty) || !(price > 0)) {
                throw new Error(`Invalid order: ${signedQty > 0 ? 'buy' : 'sell'} ${Math.abs(signedQty)} ${symbol} @ ${price}`);
            }
            this.intents.push({ symbol, signedQty, price, heldQty: this.stockBalances[symbol] || 0 });
        };
        return {
            stockName: symbol,
            candle,
            stockBalance: this.stockBalances[symbol] || 0,
            features: null,
            setFeatures() {},
            getCandles: (interval, count) => {
                if (interval !== this.interval) throw new Error(`Interval ${interval} not found. You need to request it in the strategy constructor.`);
                const candles = this.buffers.get(symbol) || [];
                return candles.length < count ? null : candles.slice(-count).reverse();
            },
            buy: (quantity, price) => enqueue(quantity, price),
            sell: (quantity, price) => enqueue(-quantity, price),
        };
    }

    async tick(timestamp, candles, { execute = true, info = {} } = {}) {
        if (execute && timestamp <= Number(this.state.lastProcessedBar || 0)) return { skipped: true, intents: [] };
        const startedAt = Date.now();
        if (execute) {
            this.cache.append(timestamp, candles);
            this.pruneCache(timestamp);
            await this.refreshAccount();
            this.snapshot(timestamp, 'pre');
        }
        this.intents = [];
        for (const { symbol, candle } of candles) this.addCandle(symbol, candle);
        const stocks = candles.map(({ symbol, candle }) => this.stockView(symbol, candle));
        this.isWarmup = !execute;
        this.currentTimestamp = timestamp;
        try {
            await this.strategy.onTick({ stocks, currentDate: new Date(timestamp), ctx: this });
        } finally {
            this.isWarmup = false;
            this.currentTimestamp = null;
        }
        const intents = this.intents.slice();
        if (!execute) return { skipped: false, intents };

        const sizingEquity = this.totalValue();
        for (const intent of intents) intent.journalId = this.journal.intent(this.runId, timestamp, { ...intent, sizingEquity });
        const stats = { orders: 0, fills: 0, skipped: 0, failed: 0 };
        const finish = (status) => this.journal.tick(this.runId, {
            ts: timestamp, durationMs: Date.now() - startedAt, ...info,
            equity: this.equity, sizingEquity: this.totalValue(), available: this.availableBalance,
            gross: this.grossExposure(), net: this.netExposure(),
            positions: Object.keys(this.stockBalances).length, intents: intents.length, ...stats, status,
        });
        try {
            this.validateBatch(intents);
        } catch (err) {
            finish('blocked');
            this.event('error', 'batch-blocked', err.message, { barTs: timestamp });
            throw err;
        }
        this.writeState({ lastProcessedBar: timestamp, status: 'executing', intentCount: intents.length });
        let fills = [];
        if (!this.dryRun) {
            try {
                fills = await this.executeBatch(timestamp, intents, stats);
            } catch (err) {
                this.snapshot(timestamp, 'post');
                this.flushTradeLogs();
                this.writeState({ ledger: this.ledger.toJSON() });
                finish('failed');
                throw err;
            }
            await this.refreshAccount();
            this.snapshot(timestamp, 'post');
            this.flushTradeLogs();
        }
        this.writeState({ lastProcessedBar: timestamp, status: this.dryRun ? 'dry-run' : 'complete', intentCount: intents.length, ledger: this.ledger.toJSON() });
        finish(this.dryRun ? 'dry-run' : 'complete');
        return { skipped: false, intents, fills };
    }

    validateBatch(intents) {
        const sizingEquity = this.totalValue();
        if (!(sizingEquity > 0)) throw new Error('Broker account equity is not positive');
        const projected = { ...this.stockBalances };
        for (const intent of intents) {
            const current = projected[intent.symbol] || 0;
            for (const leg of splitPositionOrder(current, intent.signedQty)) {
                if (!leg.reduceOnly && Math.abs(leg.signedQty * intent.price) > this.maxOrderNotional) {
                    throw new Error(`${intent.symbol} opening order exceeds $${this.maxOrderNotional} cap`);
                }
            }
            projected[intent.symbol] = current + intent.signedQty;
            if (!this.allowShort && projected[intent.symbol] < -1e-12) {
                throw new Error(`${intent.symbol} would open a short but shorting is not allowed`);
            }
        }
        let gross = 0, net = 0;
        for (const [symbol, qty] of Object.entries(projected)) {
            const px = this.stockPrices[symbol];
            if (!(px > 0)) continue;
            gross += Math.abs(qty * px);
            net += qty * px;
        }
        if (gross > this.maxLeverage * sizingEquity) {
            throw new Error(`Projected gross ${(gross / sizingEquity).toFixed(2)}x exceeds maxLeverage ${this.maxLeverage}x`);
        }
        if (Math.abs(net) > this.maxNetExposure * sizingEquity) {
            throw new Error(`Projected net ${(net / sizingEquity).toFixed(2)}x exceeds maxNetExposure ${this.maxNetExposure}x`);
        }
    }

    async executeBatch(timestamp, intents, stats) {
        const fills = [];
        const projected = { ...this.stockBalances };
        let sequence = 0;
        for (const intent of intents) {
            const current = projected[intent.symbol] || 0;
            for (const leg of splitPositionOrder(current, intent.signedQty)) {
                const quantity = this.broker.normalizeQuantity(intent.symbol, leg.signedQty, intent.price, { reduceOnly: leg.reduceOnly });
                const side = leg.signedQty > 0 ? 'buy' : 'sell';
                const orderInfo = {
                    intentId: intent.journalId, symbol: intent.symbol, side,
                    reduceOnly: leg.reduceOnly, decisionPrice: intent.price,
                };
                if (!quantity) {
                    this.logger.warn(`ForwardRunner: skipped sub-minimum order ${intent.symbol}`);
                    this.journal.orderSkipped(this.runId, timestamp, { ...orderInfo, quantity: Math.abs(leg.signedQty) }, 'below exchange quantity/notional minimum');
                    stats.skipped++;
                    continue;
                }
                const signedRounded = Math.sign(leg.signedQty) * Number(quantity);
                const clientOrderId = this.broker.createClientOrderId({ timestamp, symbol: intent.symbol, sequence: sequence++ });
                const orderId = this.journal.orderPending(this.runId, timestamp, { ...orderInfo, quantity: Number(quantity), clientOrderId });
                stats.orders++;
                try {
                    const fill = await this.broker.placeMarketOrder({
                        symbol: intent.symbol, side, quantity, reduceOnly: leg.reduceOnly, clientOrderId,
                    });
                    const parsed = this.broker.parseOrderResult(fill) || {};
                    this.journal.orderResult(orderId, parsed, fill);
                    this.recordFill(timestamp, intent, side, Number(quantity), parsed);
                    fills.push(fill);
                    stats.fills++;
                    projected[intent.symbol] = (projected[intent.symbol] || 0) + signedRounded;
                } catch (err) {
                    this.journal.orderFailed(orderId, err);
                    stats.failed++;
                    this.event('error', 'order-failed', `${intent.symbol} ${side} ${quantity}: ${err.message}`, {
                        barTs: timestamp, data: { clientOrderId, code: err.code ?? null, body: err.body ?? null },
                    });
                    await this.refreshAccount();
                    throw new Error(`Order batch stopped after ${fills.length} fills: ${err.message}`, { cause: err });
                }
            }
        }
        return fills;
    }

    recordFill(timestamp, intent, side, requestedQty, parsed) {
        const quantity = parsed.executedQty > 0 ? Number(parsed.executedQty) : requestedQty;
        const price = parsed.avgPrice > 0 ? Number(parsed.avgPrice) : intent.price;
        if (!(quantity > 0) || !(price > 0)) return;
        const fee = this.fee(intent.symbol, quantity, price, side);
        this.pendingLogs.push({ kind: 'swap', timestamp, stockName: intent.symbol, side, quantity, price, fee });
        const closed = this.ledger.apply({ symbol: intent.symbol, signedQty: side === 'buy' ? quantity : -quantity, price, fee, timestamp });
        if (closed) {
            this.pendingLogs.push({
                kind: 'trade', timestamp, stockName: intent.symbol, dir: closed.dir,
                profit: closed.profit, profitPercent: closed.profitPercent, holdMs: closed.holdMs,
            });
        }
    }

    pruneCache(latest, force = false) {
        if (!force && Date.now() - this.lastPrune < 3600000) return;
        this.lastPrune = Date.now();
        this.cache.registerConsumer(this.strategy.name, this.warmupBars);
        const removed = this.cache.prune(latest);
        if (removed) this.event('info', 'cache-pruned', `${removed} old candles removed`);
    }

    async loadHistory(symbol, fromTs, latest, endTime, counts) {
        const coverage = this.cache.coverage(symbol);
        if (coverage && coverage.from_ts <= fromTs && coverage.to_ts >= fromTs - this.stepMs) {
            const missingBars = Math.round((latest - coverage.to_ts) / this.stepMs);
            if (missingBars <= 0) {
                counts.cached++;
                return this.cache.load(symbol, fromTs, latest);
            }
            if (missingBars < this.warmupBars) {
                const fetched = (await this.broker.getHistory(symbol, this.interval, missingBars, { endTime, stepMs: this.stepMs }))
                    .filter(c => c.timestamp > coverage.to_ts && c.timestamp <= latest);
                this.cache.store(symbol, fetched, { fromTs: coverage.from_ts, toTs: latest });
                counts.topped++;
                return this.cache.load(symbol, fromTs, latest);
            }
        }
        const fetched = (await this.broker.getHistory(symbol, this.interval, this.warmupBars, { endTime, stepMs: this.stepMs }))
            .filter(c => c.timestamp >= fromTs && c.timestamp <= latest);
        this.cache.store(symbol, fetched, { fromTs, toTs: latest });
        counts.fetched++;
        return fetched;
    }

    async warmUp() {
        this.logger.log(`ForwardRunner: ${this.strategy.name} loading ${this.warmupBars} ${this.interval} bars for ${this.symbols.length} symbols`);
        const startedAt = Date.now();
        const endTime = this.broker.now();
        const latest = Math.floor(endTime / this.stepMs) * this.stepMs;
        const fromTs = latest - (this.warmupBars - 1) * this.stepMs;
        const counts = { cached: 0, topped: 0, fetched: 0 };
        const historiesRaw = await pool(this.symbols, this.concurrency, symbol => this.loadHistory(symbol, fromTs, latest, endTime, counts));
        this.pruneCache(latest, true);
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
        const last = sortedTimes.at(-1) || 0;
        const source = `${counts.cached} cached, ${counts.topped} topped up, ${counts.fetched} fetched`;
        this.logger.log(`ForwardRunner: warm-up complete through ${last ? new Date(last).toISOString() : 'n/a'} (${source}, ${Math.round((Date.now() - startedAt) / 1000)}s)`);
        this.event('info', 'warmup-complete', `${sortedTimes.length} bars, ${this.symbols.length} symbols; ${source}`, { barTs: last || null });
        return last;
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
        this.stream = this.broker.createStream({
            symbols: this.symbols,
            interval: this.interval,
            stepMs: this.stepMs,
            graceMs: this.streamGraceMs,
            logger: this.logger,
        });
        await this.stream.start();
        if (this.streamHealthTimeoutMs > 0 && typeof this.stream.waitForData === 'function') {
            await this.stream.waitForData(this.streamHealthTimeoutMs);
        }
        return this.warmUp();
    }

    async stop() {
        this.stopped = true;
        await this.stream?.stop();
    }

    async recoverMissing(batch) {
        this.lastBatchInfo = { expected: batch.expected, streamed: batch.candles.length, recovered: 0, missing: 0 };
        if (!batch.missing.length) return batch.candles;
        const recovered = await this.fetchClosedBatch(batch.timestamp, batch.missing);
        const got = new Set(recovered.map(x => x.symbol));
        const stillMissing = batch.missing.filter(s => !got.has(s));
        if (stillMissing.length / Math.max(1, batch.expected) > this.maxMissingFraction) {
            throw new Error(`Market-data batch ${new Date(batch.timestamp).toISOString()} remains incomplete: ${stillMissing.length}/${batch.expected} symbols missing after history recovery`);
        }
        this.lastBatchInfo = { expected: batch.expected, streamed: batch.candles.length, recovered: recovered.length, missing: stillMissing.length };
        if (stillMissing.length) {
            this.logger.warn(`ForwardRunner: ${stillMissing.length} inactive symbols omitted after history recovery`);
            this.event('warn', 'symbols-missing', `${stillMissing.length} symbols omitted after history recovery`, { barTs: batch.timestamp, data: stillMissing });
        }
        return [...batch.candles, ...recovered];
    }

    async recoverGap(afterTimestamp, beforeTimestamp) {
        for (let timestamp = afterTimestamp + this.stepMs; timestamp < beforeTimestamp; timestamp += this.stepMs) {
            this.logger.warn(`ForwardRunner: recovering missed bar ${new Date(timestamp).toISOString()} from history`);
            this.event('warn', 'gap-recovery', 'recovering missed bar from history', { barTs: timestamp });
            const candles = await this.fetchClosedBatch(timestamp);
            if (!candles.length) throw new Error(`No candles available for missed bar ${new Date(timestamp).toISOString()}`);
            await this.tick(timestamp, candles, {
                execute: true,
                info: { expected: this.symbols.length, streamed: 0, recovered: candles.length, missing: this.symbols.length - candles.length },
            });
        }
    }

    async run() {
        this.runId = this.journal.startRun({
            strategy: this.strategy.name,
            broker: this.broker.label,
            account: this.broker.account,
            dryRun: this.dryRun,
            capital: this.capital,
            interval: this.interval,
            config: {
                params: this.strategy.params,
                warmupBars: this.warmupBars,
                market: this.market,
                allowShort: this.allowShort,
                maxLeverage: this.maxLeverage,
                maxNetExposure: Number.isFinite(this.maxNetExposure) ? this.maxNetExposure : null,
                maxOrderNotional: Number.isFinite(this.maxOrderNotional) ? this.maxOrderNotional : null,
                maxMissingFraction: this.maxMissingFraction,
                symbols: this.fixedSymbols,
            },
        });
        let endReason = 'stopped';
        let fatal = null;
        try {
            const latestWarmup = await this.initialize();
            if (this.state.status === 'executing') {
                this.logger.warn(`ForwardRunner: previous process stopped during bar ${this.state.lastProcessedBar}; it will not be replayed`);
                this.event('warn', 'previous-incomplete', 'previous process stopped mid-batch; bar not replayed', { barTs: Number(this.state.lastProcessedBar) || null });
            }
            await this.pollIncome(true);
            let last = Math.max(latestWarmup, Number(this.state.lastProcessedBar || 0));
            this.logger.log(`ForwardRunner: ${this.strategy.name} on ${this.broker.label}${this.dryRun ? ' (dry-run)' : ''}, $${this.capital.toLocaleString('en-US')} capital; live after ${new Date(last).toISOString()}`);
            while (!this.stopped) {
                const batch = await this.stream.nextBatch();
                if (!batch) break;
                await this.refreshSymbols();
                if (batch.timestamp <= last) continue;
                if (batch.timestamp > last + this.stepMs) await this.recoverGap(last, batch.timestamp);
                const candles = await this.recoverMissing(batch);
                const result = await this.tick(batch.timestamp, candles, { execute: true, info: this.lastBatchInfo });
                last = batch.timestamp;
                if (this.logs.ticks) this.logger.log(`ForwardRunner: ${new Date(last).toISOString()} ${candles.length}/${batch.expected} candles, ${result.intents.length} intents, ${result.fills?.length || 0} fills`);
                await this.pollIncome();
            }
            if (!this.stopped) endReason = 'stream-ended';
        } catch (err) {
            endReason = 'error';
            fatal = err;
            this.event('error', 'fatal', err.message, { data: { stack: err.stack } });
            throw err;
        } finally {
            await this.stream?.stop();
            if (!fatal) await this.pollIncome(true);
            this.journal.endRun(this.runId, endReason, fatal);
            this.journal.close();
            this.cache.close();
        }
    }
}
