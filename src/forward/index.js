import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Strategy from '../backtest/strategy.js';
import Broker from '../brokers/base.js';
import { splitPositionOrder } from '../brokers/orderLegs.js';
import { intervalMsMap, markets } from '../backtest/consts.js';
import { formatSwapLine, formatTradeLine } from '../backtest/logFormat.js';
import RunJournal from '../journal.js';
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
        journal = null,
        journalFile = 'output/journal.sqlite',
        haltFile = 'output/HALT',
        maxDailyLoss = Infinity,
        adoptExisting = false,
        ignoreExisting = false,
        logger = console,
        concurrency = 16,
        symbolRefreshMs = 3600000,
        streamGraceMs = 5000,
        streamHealthTimeoutMs = 15000,
        maxMissingFraction = 0.02,
        incomePollMs = 3600000,
        incomeLookbackMs = 7 * 86400000,
        driftWarnFraction = 0.05,
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
        this.driftWarnFraction = driftWarnFraction;
        this.adoptExisting = adoptExisting;
        this.ignoreExisting = ignoreExisting;
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
        this.journal = journal instanceof RunJournal ? journal : new RunJournal({ file: journalFile });
        this.ownsJournal = !(journal instanceof RunJournal);
        this.haltFile = haltFile;
        this.maxDailyLoss = maxDailyLoss;
        this.paused = false;
        this.pauseReason = null;
        this.lastCommandId = 0;
        this.dayKey = null;
        this.dayOpenEquity = null;
        this.haltReason = null;
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
        this.pendingBatch = null;
        this.state = this.readState();
        this.ledger = new TradeLedger(this.state.ledger);
        this.realized = Number(this.state.realized) || 0;
        this.paused = Boolean(this.state.paused);
        this.traded = new Set(this.state.traded || Object.keys(this.ledger.positions));
        this.disowned = new Set(this.state.disowned || []);
        this.accountEquity = 0;
        this.baseline = null;
        this.unpricedFills = 0;
        this.driftWarned = false;
        this.adjustments = Number(this.state.adjustments) || 0;
        this.ownTag = ForwardRunner.ownerTag(strategy.name);
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

    static ownerTag(name) {
        const slug = String(name).replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 6) || 'fw';
        let hash = 0;
        for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        return `${slug}${(hash % 1296).toString(36).padStart(2, '0')}`;
    }

    totalValue() {
        return Math.max(0, this.capital + this.realized + this.unrealized());
    }

    unrealized() {
        let open = 0;
        for (const [symbol, pos] of Object.entries(this.ledger.positions)) {
            const px = this.stockPrices[symbol];
            if (!(px > 0) || !(pos.avgPrice > 0)) continue;
            open += pos.quantity * (px - pos.avgPrice) - (Number(pos.entryFees) || 0);
        }
        return open;
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
            this.attributeFunding(rows);
        } catch (err) {
            this.logger.warn(`ForwardRunner: income poll failed: ${err.message}`);
            this.event('warn', 'income-failed', err.message);
        }
    }

    attributeFunding(rows) {
        const account = new Map();
        for (const p of this.lastPortfolio?.positions || []) {
            const qty = Number(p.quantity);
            if (qty) account.set(p.symbol, Math.abs(qty));
        }
        let mine = 0;
        for (const row of rows) {
            if (row.incomeType && row.incomeType !== 'FUNDING_FEE') continue;
            const amount = Number(row.income);
            const symbol = row.symbol;
            if (!Number.isFinite(amount) || !symbol) continue;
            const own = Math.abs(Number(this.ledger.positions[symbol]?.quantity) || 0);
            if (!own) continue;
            const total = account.get(symbol) || own;
            mine += amount * Math.min(1, own / total);
        }
        if (mine) {
            this.realized += mine;
            this.writeState({ realized: this.realized });
        }
    }

    async refreshAccount() {
        const portfolio = await this.broker.getPortfolio();
        this.lastPortfolio = portfolio;
        this.cashBalance = Number(portfolio.cash ?? 0);
        this.availableBalance = Number(portfolio.available ?? 0);
        this.accountEquity = Number(portfolio.equity ?? 0);
        this.equity = this.accountEquity;

        for (const p of portfolio.positions || []) {
            const mark = Number(p.markPrice);
            if (mark > 0) this.stockPrices[p.symbol] = mark;
        }

        this.reconcileShared(portfolio.positions || []);

        for (const key of Object.keys(this.stockBalances)) delete this.stockBalances[key];
        for (const [symbol, pos] of Object.entries(this.ledger.positions)) {
            if (pos.quantity) this.stockBalances[symbol] = pos.quantity;
        }
        this.reconcileAccount();
    }

    reconcileAccount() {
        if (!(this.accountEquity > 0)) return;
        const mine = this.totalValue();
        const claimed = this.claimedShare();
        if (!(claimed > 0)) return;
        const drift = mine - claimed;
        const ratio = Math.abs(drift) / claimed;
        const over = ratio >= this.driftWarnFraction;
        if (over && !this.driftWarned) {
            this.driftWarned = true;
            this.event('warn', 'equity-drift',
                `sizing equity ${mine.toFixed(2)} is ${(ratio * 100).toFixed(1)}% `
                + `${drift > 0 ? 'above' : 'below'} the ${claimed.toFixed(2)} this strategy can account for `
                + 'on the venue; modelled fees or funding attribution have drifted');
        } else if (!over && this.driftWarned) {
            this.driftWarned = false;
            this.event('info', 'equity-drift-cleared',
                `sizing equity is back within ${(this.driftWarnFraction * 100).toFixed(0)}% of the account`);
        }
    }

    claimedShare() {
        let others = 0;
        for (const p of this.lastPortfolio?.positions || []) {
            const qty = Number(p.quantity);
            if (!qty || this.ledger.positions[p.symbol]) continue;
            others += Math.abs(qty * (Number(p.markPrice) || 0));
        }
        return this.accountEquity - others;
    }

    reconcileShared(positions) {
        const account = new Map();
        for (const p of positions) {
            const qty = Number(p.quantity);
            if (qty) account.set(p.symbol, qty);
        }
        const lost = [];
        for (const [symbol, pos] of Object.entries(this.ledger.positions)) {
            const own = Number(pos.quantity);
            if (!own) continue;
            const held = account.get(symbol) || 0;
            if (Math.sign(held) === Math.sign(own) && Math.abs(held) >= Math.abs(own) - 1e-9) continue;
            const remaining = Math.sign(held) === Math.sign(own) ? held : 0;
            lost.push({ symbol, expected: own, found: remaining });
            const price = this.stockPrices[symbol] || pos.avgPrice || 0;
            this.realized += (own - remaining) * (price - pos.avgPrice);
            if (remaining) this.ledger.positions[symbol] = { ...pos, quantity: remaining };
            else delete this.ledger.positions[symbol];
        }
        if (lost.length) {
            this.logger.warn(`ForwardRunner: ${lost.length} position(s) smaller than this strategy's book; adopting the venue`);
            this.event('warn', 'position-divergence',
                `${lost.length} position(s) closed outside this strategy`,
                { data: lost });
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

    async tick(timestamp, candles, { execute = true, paused = false, info = {} } = {}) {
        if (execute && timestamp <= Number(this.state.lastProcessedBar || 0)) return { skipped: true, intents: [] };
        const startedAt = Date.now();
        if (execute) {
            this.cache.append(timestamp, candles);
            this.pruneCache(timestamp);
            await this.refreshAccount();
            this.snapshot(timestamp, 'pre');
            const halt = this.checkHalt(timestamp);
            if (halt) {
                this.event('warn', 'halt', halt, { barTs: timestamp });
                await this.flatten(timestamp, halt);
                this.haltReason = halt;
                await this.stop();
                return { skipped: true, halted: halt, intents: [] };
            }
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

        if (paused) {
            this.journal.tick(this.runId, {
                ts: timestamp, durationMs: Date.now() - startedAt, ...info,
                equity: this.equity, sizingEquity, available: this.availableBalance,
                gross: this.grossExposure(), net: this.netExposure(),
                positions: Object.keys(this.stockBalances).length, intents: intents.length,
                ...stats, skipped: intents.length, status: 'paused',
            });
            this.writeState({ lastProcessedBar: timestamp, status: 'paused' });
            return { skipped: true, paused: true, intents };
        }

        const unmanaged = this.unmanagedPositions();
        if (unmanaged.length) {
            this.journal.record(this.runId, timestamp, 'unmanaged', {
                value: unmanaged.reduce((s, p) => s + Math.abs(p.quantity * p.price), 0),
                symbols: unmanaged.map((p) => p.symbol),
            });
        }
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
        this.writeState({ lastProcessedBar: timestamp, status: 'executing', runId: this.runId, intentCount: intents.length });
        let fills = [];
        if (!this.dryRun) {
            try {
                fills = await this.executeBatch(timestamp, intents, stats);
            } catch (err) {
                this.snapshot(timestamp, 'post');
                this.flushTradeLogs();
                this.writeState({ ledger: this.ledger.toJSON(), realized: this.realized, traded: [...this.traded], disowned: [...this.disowned] });
                finish('failed');
                throw err;
            }
            await this.refreshAccount();
            this.snapshot(timestamp, 'post');
            this.flushTradeLogs();
        }
        this.writeState({ lastProcessedBar: timestamp, status: this.dryRun ? 'dry-run' : 'complete', runId: this.runId, intentCount: intents.length, ledger: this.ledger.toJSON(), realized: this.realized, traded: [...this.traded], disowned: [...this.disowned] });
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

    async executeBatch(timestamp, intents, stats, { forceReduceOnly = false } = {}) {
        const fills = [];
        this.unpricedFills = 0;
        const projected = { ...this.stockBalances };
        let sequence = 0;
        for (const intent of intents) {
            const current = projected[intent.symbol] || 0;
            for (const leg of splitPositionOrder(current, intent.signedQty).map(
                (l) => (forceReduceOnly ? { ...l, reduceOnly: true } : l))) {
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
                const clientOrderId = this.broker.createClientOrderId({
                    timestamp, symbol: intent.symbol, sequence: sequence++, owner: this.ownTag,
                });
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
        if (this.unpricedFills) {
            this.event('warn', 'fill-price-missing',
                `${this.unpricedFills} of ${fills.length} fills came back without a price, `
                + 'those are booked at the decision price and their slippage is unmeasured',
                { barTs: timestamp });
        }
        return fills;
    }

    recordFill(timestamp, intent, side, requestedQty, parsed) {
        const quantity = parsed.executedQty > 0 ? Number(parsed.executedQty) : requestedQty;
        const filled = parsed.avgPrice > 0 ? Number(parsed.avgPrice) : null;
        const price = filled ?? intent.price;
        if (filled == null) this.unpricedFills++;
        if (!(quantity > 0) || !(price > 0)) return;
        this.traded.add(intent.symbol);
        const fee = this.fee(intent.symbol, quantity, price, side);
        this.pendingLogs.push({ kind: 'swap', timestamp, stockName: intent.symbol, side, quantity, price, fee });
        const closed = this.ledger.apply({ symbol: intent.symbol, signedQty: side === 'buy' ? quantity : -quantity, price, fee, timestamp });
        if (closed) {
            this.realized += closed.profit;
            this.pendingLogs.push({
                kind: 'trade', timestamp, stockName: intent.symbol, dir: closed.dir,
                profit: closed.profit, profitPercent: closed.profitPercent, holdMs: closed.holdMs,
            });
        }
        this.writeState({
            status: 'executing',
            ledger: this.ledger.toJSON(),
            realized: this.realized,
            traded: [...this.traded],
            disowned: [...this.disowned],
        });
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
        this.claimExistingPositions();
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

    claimExistingPositions() {
        if (Object.keys(this.ledger.positions).length) return;
        const held = (this.lastPortfolio?.positions || []).filter((p) => Number(p.quantity));
        if (!held.length) return;

        if (this.adoptExisting) {
            this.ledger.reconcile(held, (symbol, quantity, price) => this.fee(symbol, quantity, price, 'buy'));
            for (const [symbol, pos] of Object.entries(this.ledger.positions)) {
                if (pos.quantity) this.stockBalances[symbol] = pos.quantity;
            }
            for (const p of held) this.traded.add(p.symbol);
            this.writeState({ ledger: this.ledger.toJSON(), realized: this.realized, traded: [...this.traded], disowned: [...this.disowned] });
            this.event('warn', 'adopted-positions', `adopted ${held.length} existing positions`, {
                data: held.map((p) => p.symbol),
            });
            return;
        }
        if (this.ignoreExisting) {
            for (const p of held) this.disowned.add(p.symbol);
            this.writeState({ disowned: [...this.disowned] });
            this.event('info', 'ignored-positions', `${held.length} positions on the account belong to someone else`, {
                data: held.map((p) => p.symbol),
            });
            return;
        }
        throw new Error(
            `${this.broker.account} already holds ${held.length} position(s) (${held.slice(0, 5).map((p) => p.symbol).join(', ')}`
            + `${held.length > 5 ? ', …' : ''}) and this strategy has no book of its own. `
            + 'Start with adoptExisting to take them over, or ignoreExisting if another strategy owns them.',
        );
    }

    async stop() {
        this.stopped = true;
        await this.stream?.stop();
    }

    waitForSignal(pollMs = 1000) {
        let timer = null;
        let cancelled = false;
        const promise = new Promise((resolve) => {
            const check = () => {
                if (cancelled) return;
                const halt = this.haltFileReason();
                if (halt) return resolve({ halt });
                const command = this.readCommand();
                if (command) return resolve({ command });
                timer = setTimeout(check, pollMs);
                timer.unref?.();
            };
            check();
        });
        return {
            promise,
            cancel: () => {
                cancelled = true;
                if (timer) clearTimeout(timer);
            },
        };
    }

    readCommand() {
        if (!this.runId) return null;
        const row = this.journal.nextCommand(this.runId, this.lastCommandId);
        if (!row) return null;
        if (!['pause', 'resume', 'stop'].includes(row.command)) {
            this.journal.ackCommands(this.runId, row.id);
            this.lastCommandId = row.id;
            return null;
        }
        return { id: row.id, command: row.command, note: row.note || '' };
    }

    resetAllocation() {
        const previous = this.journal.previousRun({
            strategy: this.strategy.name,
            account: this.broker.account,
            dryRun: this.dryRun,
            before: this.runId,
        });
        if (previous && previous.endReason === 'stopped') {
            if (this.realized || this.adjustments) {
                this.event('info', 'allocation-reset',
                    `run ${previous.id} was stopped holding ${this.realized.toFixed(2)} realized `
                    + `and ${this.adjustments.toFixed(2)} of adjustments; starting from the `
                    + `${this.capital} allocation`);
            }
            this.realized = 0;
            this.adjustments = 0;
            this.writeState({ realized: 0, adjustments: 0, runId: this.runId });
            return;
        }
        if (this.adjustments) this.capital = Math.max(0, this.capital + this.adjustments);
        this.writeState({ runId: this.runId });
    }

    async applyCommand({ id, command, note, amount }) {
        this.lastCommandId = id;
        this.journal.ackCommands(this.runId, id);
        const detail = note ? `: ${note}` : '';
        if (command === 'stop') {
            const now = Date.now();
            this.event('warn', 'stop', `stop requested${detail}`, { barTs: now });
            await this.refreshAccount();
            this.snapshot(now, 'pre');
            await this.flatten(now, `stop requested${detail}`);
            await this.stop();
            return 'stopped';
        }
        if (command === 'adjust') {
            const delta = Number(amount);
            if (!Number.isFinite(delta) || !delta) return null;
            const now = Date.now();
            const before = this.capital;
            this.capital = Math.max(0, this.capital + delta);
            const applied = this.capital - before;
            this.adjustments += applied;
            this.journal.adjustCapital(this.runId, applied);
            this.journal.record(this.runId, now, 'allocation', {
                value: applied, from: before, to: this.capital, note: note || '',
            });
            this.event('info', 'allocation',
                `allocation ${applied >= 0 ? '+' : ''}${applied.toFixed(2)} to ${this.capital.toFixed(2)}${detail}`,
                { barTs: now });
            this.writeState({ adjustments: this.adjustments });
            return null;
        }
        if (command === 'pause') {
            if (this.paused) return null;
            const now = Date.now();
            this.event('warn', 'pause', `paused${detail}`, { barTs: now });
            await this.refreshAccount();
            this.snapshot(now, 'pre');
            await this.flatten(now, `paused${detail}`);
            await this.refreshAccount();
            this.paused = true;
            this.pauseReason = note || 'paused from terminal';
            this.journal.record(this.runId, now, 'paused', { paused: true, note: this.pauseReason });
            this.writeState({ paused: true, ledger: this.ledger.toJSON(), realized: this.realized, traded: [...this.traded], disowned: [...this.disowned] });
            return null;
        }
        if (!this.paused) return null;
        const now = Date.now();
        this.event('info', 'resume', `resumed${detail}`, { barTs: now });
        this.paused = false;
        this.pauseReason = null;
        this.journal.record(this.runId, now, 'paused', { paused: false, note: note || '' });
        this.writeState({ paused: false });
        return null;
    }

    /** Returns a reason to stop trading, or null. */
    haltFileReason() {
        if (this.haltFile && existsSync(this.haltFile)) {
            let note = '';
            try { note = readFileSync(this.haltFile, 'utf8').trim().slice(0, 200); } catch { /* empty is fine */ }
            return `halt file present${note ? `: ${note}` : ''}`;
        }
        return null;
    }

    /** Returns a reason to stop trading, or null. */
    checkHalt(timestamp) {
        const fileHalt = this.haltFileReason();
        if (fileHalt) return fileHalt;
        if (!Number.isFinite(this.maxDailyLoss)) return null;

        const day = new Date(timestamp).toISOString().slice(0, 10);
        const equity = this.totalValue();
        if (day !== this.dayKey) {
            this.dayKey = day;
            this.dayOpenEquity = equity;
            return null;
        }
        if (!(this.dayOpenEquity > 0)) return null;
        const loss = 1 - equity / this.dayOpenEquity;
        if (loss >= this.maxDailyLoss) {
            return `daily loss ${(loss * 100).toFixed(2)}% reached the ${(this.maxDailyLoss * 100).toFixed(2)}% limit`;
        }
        return null;
    }

    /** Closes every open position with reduce-only market orders. */
    async flatten(timestamp, reason) {
        const open = Object.entries(this.stockBalances).filter(([, qty]) => Number(qty));
        if (!open.length) return [];
        this.event('warn', 'flatten', `closing ${open.length} positions: ${reason}`, { barTs: timestamp });
        const intents = open.map(([symbol, qty]) => ({
            symbol,
            signedQty: -Number(qty),
            price: this.stockPrices[symbol] || 0,
            heldQty: Number(qty),
        }));
        for (const intent of intents) {
            intent.journalId = this.journal.intent(this.runId, timestamp, { ...intent, sizingEquity: this.totalValue() });
        }
        const stats = { orders: 0, fills: 0, skipped: 0, failed: 0 };
        try {
            const fills = await this.executeBatch(timestamp, intents, stats, { forceReduceOnly: true });
            await this.refreshAccount();
            this.snapshot(timestamp, 'flat');
            return fills;
        } catch (err) {
            this.event('error', 'flatten-failed', err.message, { barTs: timestamp });
            return [];
        }
    }

    unmanagedPositions() {
        return (this.lastPortfolio?.positions || [])
            .filter((p) => Number(p.quantity))
            .filter((p) => !this.traded.has(p.symbol) && !this.disowned.has(p.symbol))
            .map((p) => ({
                symbol: p.symbol,
                quantity: Number(p.quantity),
                price: Number(p.markPrice) || this.stockPrices[p.symbol] || 0,
            }));
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
            mode: this.dryRun ? 'paper' : this.broker.tradingMode,
            strategyVersionId: this.journal.strategyVersion({
                name: this.strategy.name,
                market: this.market,
                sourcePath: this.strategy.sourcePath ?? null,
                params: this.strategy.params,
            }),
            market: this.market,
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
        if (this.paused) {
            this.journal.record(this.runId, Date.now(), 'paused', { paused: true, note: 'resumed process while paused' });
        }
        let endReason = 'stopped';
        let fatal = null;
        try {
            this.resetAllocation();
            const latestWarmup = await this.initialize();
            this.baseline = this.totalValue();
            this.journal.baselineEquity(this.runId, this.baseline);
            if (this.state.status === 'executing') {
                this.logger.warn(`ForwardRunner: previous process stopped during bar ${this.state.lastProcessedBar}; it will not be replayed`);
                this.event('warn', 'previous-incomplete', 'previous process stopped mid-batch; bar not replayed', { barTs: Number(this.state.lastProcessedBar) || null });
            }
            await this.pollIncome(true);
            let last = Math.max(latestWarmup, Number(this.state.lastProcessedBar || 0));
            this.logger.log(`ForwardRunner: ${this.strategy.name} on ${this.broker.label}${this.dryRun ? ' (dry-run)' : ''}, $${this.capital.toLocaleString('en-US')} capital; live after ${new Date(last).toISOString()}`);
            while (!this.stopped) {
                this.pendingBatch ??= this.stream.nextBatch().then((batch) => ({ batch }));
                const signal = this.waitForSignal();
                const next = await Promise.race([this.pendingBatch, signal.promise]);
                signal.cancel();
                if (next.command) {
                    const outcome = await this.applyCommand(next.command);
                    if (outcome === 'stopped') {
                        endReason = 'stopped';
                        break;
                    }
                    continue;
                }
                if (next.halt) {
                    const now = Date.now();
                    this.event('warn', 'halt', next.halt, { barTs: now });
                    await this.refreshAccount();
                    this.snapshot(now, 'pre');
                    await this.flatten(now, next.halt);
                    this.haltReason = next.halt;
                    endReason = 'halted';
                    await this.stop();
                    break;
                }
                this.pendingBatch = null;
                const batch = next.batch;
                if (!batch) break;
                await this.refreshSymbols();
                if (batch.timestamp <= last) continue;
                if (batch.timestamp > last + this.stepMs) await this.recoverGap(last, batch.timestamp);
                const candles = await this.recoverMissing(batch);
                const result = await this.tick(batch.timestamp, candles, {
                    execute: true, paused: this.paused, info: this.lastBatchInfo,
                });
                last = batch.timestamp;
                if (result.halted) endReason = 'halted';
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
            this.journal.finishRun(this.runId, { finalEquity: this.totalValue() });
            if (this.ownsJournal) this.journal.close();
            this.cache.close();
        }
    }
}
