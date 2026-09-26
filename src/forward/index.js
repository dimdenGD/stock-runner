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
import { inspectPendingOrder, remainingBatchIntents } from './recovery.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

const SETTLEMENT_SLACK_MS = 60000;
const UNRECOVERABLE_CODES = new Set([-1022, -2014, -2015]);
const LEVERAGE_HEADROOM = 3;

function heldAt(log, time) {
    let qty = 0;
    for (const [ts, q] of log) {
        if (ts > time - SETTLEMENT_SLACK_MS) break;
        qty = q;
    }
    return qty;
}

const sameCandle = (a, b) => a.open === b.open && a.high === b.high && a.low === b.low
    && a.close === b.close && a.volume === b.volume && a.quoteVolume === b.quoteVolume;

function unrecoverable(err) {
    if (err?.fatal) return true;
    if (err?.status === 401 || err?.status === 403) return true;
    return UNRECOVERABLE_CODES.has(err?.code);
}

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
        streamSettleMs = undefined,
        streamHealthTimeoutMs = 15000,
        maxMissingFraction = 0.02,
        incomePollMs = 3600000,
        incomeLookbackMs = 7 * 86400000,
        driftWarnFraction = 0.05,
        maxOrderFailures = 5,
        maxOrderAttempts = 3,
        maxConsecutiveBarErrors = 3,
        resumeRunId = null,
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
        this.streamSettleMs = streamSettleMs;
        this.pendingCorrections = new Map();
        this.correctionLog = new Map();
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
        this.maxOrderFailures = maxOrderFailures;
        this.maxOrderAttempts = Math.min(3, Math.max(1, Math.trunc(Number(maxOrderAttempts) || 1)));
        this.maxConsecutiveBarErrors = maxConsecutiveBarErrors;
        this.consecutiveBarErrors = 0;
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
        this.venueLeverage = {};
        this.accountLeverageCap = null;
        this.leverageChecked = new Set();
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
        this.funding = this.state.funding ?? null;
        if (this.tracksFunding()) this.fundingBook();
        this.resumeRunId = Number.isInteger(Number(resumeRunId)) && Number(resumeRunId) > 0
            ? Number(resumeRunId)
            : null;
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
        if (this.funding) this.state.funding = this.funding;
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
            if (rows) {
                const inserted = this.journal.income(this.broker.account, this.runId, rows);
                if (inserted) this.event('info', 'income', `${inserted} income rows`);
            }
        } catch (err) {
            this.logger.warn(`ForwardRunner: income poll failed: ${err.message}`);
            this.event('warn', 'income-failed', err.message);
        }
        await this.accrueFunding();
    }

    tracksFunding() {
        return this.market === 'crypto' && this.broker.getFundingRates !== Broker.prototype.getFundingRates;
    }

    fundingBook() {
        if (this.funding) return this.funding;
        const since = Math.min(Date.now(), this.journal?.lastIncomeTime?.(this.broker?.account) ?? Infinity);
        const held = {};
        const through = {};
        for (const [symbol, pos] of Object.entries(this.ledger.positions)) {
            if (!Number(pos.quantity)) continue;
            held[symbol] = [[0, Number(pos.quantity)]];
            through[symbol] = since;
        }
        this.funding = { held, through };
        return this.funding;
    }

    logHoldings(ts) {
        if (!this.tracksFunding()) return;
        const book = this.fundingBook();
        for (const symbol of new Set([...Object.keys(book.held), ...Object.keys(this.ledger.positions)])) {
            const qty = Number(this.ledger.positions[symbol]?.quantity) || 0;
            const log = book.held[symbol] ?? [];
            const prev = log.at(-1);
            if ((prev?.[1] ?? 0) === qty) continue;
            log.push([Math.max(Number(ts), prev?.[0] ?? -Infinity), qty]);
            book.held[symbol] = log;
        }
    }

    async accrueFunding(now = Date.now()) {
        if (!this.tracksFunding()) return;
        const book = this.fundingBook();
        let amount = 0;
        let settlements = 0;
        const failed = [];
        await pool(Object.keys(book.held), this.concurrency, async (symbol) => {
            const log = book.held[symbol];
            const from = book.through[symbol] ?? log[0][0];
            let rates;
            try {
                rates = await this.broker.getFundingRates(symbol, { startTime: from + 1, endTime: now });
            } catch (err) {
                failed.push(`${symbol}: ${err.message}`);
                return;
            }
            let through = from;
            for (const r of [...(rates || [])].sort((a, b) => a.time - b.time)) {
                if (!(r.time > from) || !Number.isFinite(r.rate)) continue;
                through = r.time;
                const qty = heldAt(log, r.time);
                const price = r.markPrice > 0 ? r.markPrice : this.stockPrices[symbol];
                if (!qty || !(price > 0)) continue;
                amount -= qty * price * r.rate;
                settlements++;
            }
            book.through[symbol] = through;
            const cut = through - SETTLEMENT_SLACK_MS;
            let first = 0;
            while (first + 1 < log.length && log[first + 1][0] <= cut) first++;
            log.splice(0, first);
            if (log.length === 1 && log[0][1] === 0 && log[0][0] <= cut) {
                delete book.held[symbol];
                delete book.through[symbol];
            }
        });
        if (failed.length) {
            this.logger.warn(`ForwardRunner: funding rates unavailable for ${failed.length} symbol(s)`);
            this.event('warn', 'funding-failed', `funding rates unavailable for ${failed.length} symbol(s); retried next poll`, { data: failed });
        }
        if (amount) this.realized += amount;
        this.writeState({ realized: this.realized });
        if (settlements) this.journal.record(this.runId, now, 'funding', { value: amount, settlements });
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
            if (p.leverage > 0) this.venueLeverage[p.symbol] = Number(p.leverage);
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
            this.logHoldings(Date.now());
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

    applyCandleCorrection({ timestamp, symbol, candle }) {
        if (timestamp > Number(this.state.lastProcessedBar || 0)) {
            if (!this.pendingCorrections.has(timestamp)) this.pendingCorrections.set(timestamp, new Map());
            this.pendingCorrections.get(timestamp).set(symbol, candle);
            return;
        }
        const buffer = this.buffers.get(symbol);
        const at = buffer ? buffer.findIndex((c) => c.timestamp === timestamp) : -1;
        if (at >= 0 && sameCandle(buffer[at], candle)) return;
        this.cache.append(timestamp, [{ symbol, candle }]);
        if (at >= 0) {
            buffer[at] = candle;
            if (at === buffer.length - 1) this.stockPrices[symbol] = candle.close;
        }
        if (!this.correctionLog.has(timestamp)) this.correctionLog.set(timestamp, []);
        this.correctionLog.get(timestamp).push(symbol);
    }

    withCorrections(timestamp, candles) {
        for (const ts of this.pendingCorrections.keys()) if (ts < timestamp) this.pendingCorrections.delete(ts);
        const fixes = this.pendingCorrections.get(timestamp);
        if (!fixes) return candles;
        this.pendingCorrections.delete(timestamp);
        const changed = [];
        const out = candles.map((row) => {
            const fix = fixes.get(row.symbol);
            if (!fix) return row;
            fixes.delete(row.symbol);
            if (!sameCandle(row.candle, fix)) changed.push(row.symbol);
            return { symbol: row.symbol, candle: fix };
        });
        for (const [symbol, candle] of fixes) out.push({ symbol, candle });
        if (changed.length) {
            if (!this.correctionLog.has(timestamp)) this.correctionLog.set(timestamp, []);
            this.correctionLog.get(timestamp).push(...changed);
        }
        return out;
    }

    journalCorrections(beforeTimestamp) {
        for (const [ts, symbols] of this.correctionLog) {
            if (ts >= beforeTimestamp) continue;
            this.correctionLog.delete(ts);
            this.event('info', 'candles-corrected',
                `${symbols.length} candle(s) replaced by a later closed candle: ${symbols.slice(0, 8).join(', ')}${symbols.length > 8 ? ', ...' : ''}`,
                { barTs: ts, data: symbols });
        }
    }

    async tick(timestamp, candles, { execute = true, paused = false, info = {} } = {}) {
        if (execute && timestamp <= Number(this.state.lastProcessedBar || 0)) return { skipped: true, intents: [] };
        const startedAt = Date.now();
        if (execute) {
            candles = this.withCorrections(timestamp, candles);
            this.journalCorrections(timestamp);
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
        this.writeState({
            lastProcessedBar: timestamp,
            status: 'executing',
            runId: this.runId,
            intentCount: intents.length,
            appliedOrderIds: [],
        });
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
        this.writeState({
            lastProcessedBar: timestamp,
            status: this.dryRun ? 'dry-run' : 'complete',
            runId: this.runId,
            intentCount: intents.length,
            ledger: this.ledger.toJSON(),
            realized: this.realized,
            traded: [...this.traded],
            disowned: [...this.disowned],
            appliedOrderIds: [],
        });
        finish(this.dryRun ? 'dry-run' : stats.failed ? 'partial' : 'complete');
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
        this.unpricedFills = 0;
        const run = {
            timestamp, stats, forceReduceOnly,
            fills: [],
            skippedSymbols: [],
            sequence: 0,
            projected: { ...this.stockBalances },
            maxAttempts: Math.min(3, Math.max(1, Math.trunc(Number(this.maxOrderAttempts) || 1))),
        };
        const width = Math.max(1, Math.trunc(Number(this.broker.orderConcurrency) || 1));
        if (width > 1) {
            if (await this.executeConcurrently(run, intents, width) === 'abandon') return run.fills;
        } else {
            for (const intent of intents) {
                for (const leg of this.planLegs(run, intent)) {
                    if (await this.placeLeg(run, intent, leg) === 'abandon') return run.fills;
                }
            }
        }
        if (run.skippedSymbols.length) {
            const shown = run.skippedSymbols.slice(0, 12).join(', ');
            const rest = run.skippedSymbols.length - 12;
            this.logger.warn(`ForwardRunner: ${run.skippedSymbols.length} order(s) below exchange minimum: ${shown}${rest > 0 ? `, +${rest} more` : ''}`);
        }
        if (this.unpricedFills) {
            this.event('warn', 'fill-price-missing',
                `${this.unpricedFills} of ${run.fills.length} fills came back without a price, `
                + 'those are booked at the decision price and their slippage is unmeasured',
                { barTs: timestamp });
        }
        return run.fills;
    }

    planLegs(run, intent) {
        const current = run.projected[intent.symbol] || 0;
        return splitPositionOrder(current, intent.signedQty)
            .map((l) => (run.forceReduceOnly ? { ...l, reduceOnly: true } : l))
            .flatMap((l) => (this.broker.splitMaxQty?.(intent.symbol, l.signedQty) ?? [l.signedQty]).map((q) => ({ ...l, signedQty: q })));
    }

    async executeConcurrently(run, intents, width) {
        const chains = new Map();
        for (const intent of intents) {
            if (!chains.has(intent.symbol)) chains.set(intent.symbol, []);
            chains.get(intent.symbol).push(intent);
        }
        let reducing = chains.size;
        let releaseOpens;
        const opensAllowed = new Promise((resolve) => { releaseOpens = resolve; });
        if (!reducing) releaseOpens();
        const slots = { free: width, waiting: [] };
        const acquire = () => (slots.free > 0 ? (slots.free--, Promise.resolve()) : new Promise((resolve) => slots.waiting.push(resolve)));
        const release = () => { const next = slots.waiting.shift(); if (next) next(); else slots.free++; };
        let stop = null;
        const halt = (reason) => {
            if (!(stop instanceof Error)) stop = reason;
        };

        const runChain = async (list) => {
            let reduced = false;
            const pastReductions = () => {
                if (reduced) return;
                reduced = true;
                if (--reducing === 0) releaseOpens();
            };
            try {
                for (const intent of list) {
                    for (const leg of this.planLegs(run, intent)) {
                        if (stop || run.halted) return;
                        if (!leg.reduceOnly) {
                            pastReductions();
                            await opensAllowed;
                            if (stop || run.halted) return;
                        }
                        await acquire();
                        try {
                            if (stop || run.halted) return;
                            if (await this.placeLeg(run, intent, leg) === 'abandon') halt('abandon');
                        } finally {
                            release();
                        }
                    }
                }
            } catch (err) {
                halt(err);
            } finally {
                pastReductions();
            }
        };
        await Promise.all([...chains.values()].map(runChain));
        if (stop instanceof Error) throw stop;
        return stop;
    }

    async placeLeg(run, intent, leg) {
        const { timestamp, stats, maxAttempts } = run;
        const quantity = this.broker.normalizeQuantity(intent.symbol, leg.signedQty, intent.price, { reduceOnly: leg.reduceOnly });
        const side = leg.signedQty > 0 ? 'buy' : 'sell';
        const orderInfo = {
            intentId: intent.journalId, symbol: intent.symbol, side,
            reduceOnly: leg.reduceOnly, decisionPrice: intent.price,
        };
        if (!quantity) {
            run.skippedSymbols.push(intent.symbol);
            this.journal.orderSkipped(this.runId, timestamp, { ...orderInfo, quantity: Math.abs(leg.signedQty) }, 'below exchange quantity/notional minimum');
            stats.skipped++;
            return 'skipped';
        }
        await this.ensureLeverage(intent.symbol);
        const signedRounded = Math.sign(leg.signedQty) * Number(quantity);
        const clientOrderId = this.broker.createClientOrderId({
            timestamp, symbol: intent.symbol, sequence: run.sequence++, owner: this.ownTag,
        });
        const orderId = this.journal.orderPending(this.runId, timestamp, { ...orderInfo, quantity: Number(quantity), clientOrderId });
        stats.orders++;
        let fill;
        let placed = false;
        let accepted = false;
        let placementError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                fill = await this.broker.placeMarketOrder({
                    symbol: intent.symbol, side, quantity, reduceOnly: leg.reduceOnly, clientOrderId,
                });
                accepted = true;
                if (typeof this.broker.finalizeOrderResult === 'function') {
                    fill = await this.broker.finalizeOrderResult(fill, {
                        symbol: intent.symbol,
                        side,
                        quantity: Number(quantity),
                        reduceOnly: leg.reduceOnly,
                        clientOrderId,
                    });
                }
                placed = true;
                break;
            } catch (err) {
                placementError = err;
                const disposition = accepted
                    ? { action: 'ambiguous' }
                    : typeof this.broker.orderFailureDisposition === 'function'
                    ? this.broker.orderFailureDisposition(err, {
                        attempt,
                        maxAttempts,
                        symbol: intent.symbol,
                        side,
                        clientOrderId,
                    }) || { action: 'ambiguous' }
                    : { action: 'reject' };
                if (disposition.action === 'retry' && attempt < maxAttempts) {
                    const delayMs = Math.max(0, Number(disposition.delayMs) || 0);
                    stats.retries = (stats.retries || 0) + 1;
                    this.event('warn', 'order-retry',
                        `${intent.symbol} ${side} ${quantity}: attempt ${attempt} failed; `
                            + `retrying in ${delayMs}ms`,
                        { barTs: timestamp, data: { clientOrderId, attempt, delayMs, code: err.code ?? null } });
                    if (delayMs) await sleep(delayMs);
                    continue;
                }
                if (disposition.action === 'ambiguous') {
                    this.event('error', 'order-unanswered',
                        `${intent.symbol} ${side} ${quantity}: venue outcome is ambiguous; restarting into reconciliation`,
                        { barTs: timestamp, data: { clientOrderId, attempt, code: err.code ?? null } });
                    run.halted = true;
                    err.fatal = true;
                    err.restartRunner = true;
                    throw err;
                }
                break;
            }
        }
        if (!placed) {
            const err = placementError || new Error('order placement failed without an error');
            this.journal.orderFailed(orderId, err);
            stats.failed++;
            this.event('error', 'order-failed', `${intent.symbol} ${side} ${quantity}: ${err.message}`, {
                barTs: timestamp, data: { clientOrderId, code: err.code ?? null, body: err.body ?? null },
            });
            if (unrecoverable(err)) {
                run.halted = true;
                await this.refreshAccount();
                err.fatal = true;
                throw err;
            }
            if (stats.failed >= this.maxOrderFailures) {
                run.halted = true;
                if (!run.abandoned) {
                    run.abandoned = true;
                    this.event('error', 'batch-abandoned',
                        `${stats.failed} orders rejected in one batch, ${run.fills.length} filled; `
                        + 'the rest of the batch was dropped',
                        { barTs: timestamp });
                }
                return 'abandon';
            }
            return 'failed';
        }
        const parsed = this.broker.parseOrderResult(fill) || {};
        const executedQty = Number(parsed.executedQty) > 0
            ? Number(parsed.executedQty)
            : Number(quantity);
        const completionTolerance = Math.max(1e-12, Number(quantity) * 1e-9);
        const partiallyFilled = executedQty + completionTolerance < Number(quantity);
        const booked = partiallyFilled ? { ...parsed, status: 'filled' } : parsed;
        this.journal.orderResult(orderId, booked, fill);
        this.recordFill(timestamp, intent, side, Number(quantity), booked, orderId);
        run.fills.push(fill);
        stats.fills++;
        run.projected[intent.symbol] = (run.projected[intent.symbol] || 0)
            + Math.sign(signedRounded) * executedQty;
        if (partiallyFilled) {
            this.event('warn', 'order-partial',
                `${intent.symbol} ${side} filled ${executedQty} of ${quantity}; restarting into target reconciliation`,
                { barTs: timestamp, data: { clientOrderId, requestedQty: Number(quantity), executedQty } });
            const error = new Error(
                `${intent.symbol} order only filled ${executedQty} of ${quantity}`,
            );
            error.code = 'PARTIAL_FILL';
            run.halted = true;
            error.fatal = true;
            error.restartRunner = true;
            throw error;
        }
        return 'filled';
    }

    /**
     * Finish a batch whose process died after its strategy intents were
     * journalled but before every venue response was durably recorded.
     */
    async recoverInterruptedBatch(timestamp) {
        const answeredRows = this.journal.answeredOrdersAt(this.runId, timestamp);
        if (answeredRows.length && !Array.isArray(this.state.appliedOrderIds)) {
            this.event('error', 'recovery-blocked',
                'interrupted state predates exact fill-application tracking; refusing to guess which answered orders are already in the owned book',
                { barTs: timestamp, data: { answeredOrderIds: answeredRows.map((row) => row.id) } });
            throw new Error('Interrupted state has answered orders but no exact fill-application markers');
        }
        const applied = new Set((this.state.appliedOrderIds || []).map(Number));
        let journalledFills = 0;
        for (const row of answeredRows) {
            if (applied.has(Number(row.id))) continue;
            this.recordFill(timestamp, {
                symbol: row.symbol,
                price: Number(row.decision_price) || Number(row.avg_price),
            }, row.side, Number(row.quantity), {
                status: row.status,
                exchangeOrderId: row.exchange_order_id,
                executedQty: Number(row.executed_qty),
                avgPrice: Number(row.avg_price),
            }, row.id);
            journalledFills++;
        }

        const rows = this.journal.pendingOrdersAt(this.runId, timestamp);
        const inspected = await Promise.all(rows.map((row) => inspectPendingOrder(this.broker, row)));
        let recoveredFills = 0;
        let neverPlaced = 0;
        const unresolved = [];

        for (let i = 0; i < inspected.length; i++) {
            const result = inspected[i];
            const row = rows[i];
            if (result.outcome === 'filled') {
                this.journal.orderResult(row.id, result.parsed, result.response);
                this.recordFill(
                    timestamp,
                    { symbol: row.symbol, price: Number(row.decision_price) || result.avgPrice },
                    row.side,
                    Number(row.quantity),
                    result.parsed,
                    row.id,
                );
                recoveredFills++;
            } else if (result.outcome === 'rejected') {
                const error = new Error(result.reason || 'the venue has no record of this order');
                error.code = 'unanswered';
                error.body = result.response;
                this.journal.orderFailed(row.id, error);
                neverPlaced++;
            } else {
                unresolved.push(result);
            }
        }

        if (unresolved.length) {
            const detail = unresolved.slice(0, 3).map((row) => `${row.symbol}: ${row.error}`).join('; ');
            this.event('error', 'recovery-blocked',
                `cannot safely finish interrupted bar while ${unresolved.length} order(s) remain ambiguous: ${detail}`,
                { barTs: timestamp, data: unresolved });
            throw new Error(`Interrupted-order reconciliation failed: ${detail}`);
        }

        await this.refreshAccount();
        const sourceIntents = this.journal.intentsAt(this.runId, timestamp);
        const intents = remainingBatchIntents(sourceIntents, this.stockBalances, this.stockPrices);
        const stats = { orders: 0, fills: 0, skipped: 0, failed: 0 };
        const fills = this.dryRun ? [] : await this.executeBatch(timestamp, intents, stats);
        await this.refreshAccount();
        this.snapshot(timestamp, 'recovered');
        this.flushTradeLogs();

        if (stats.failed) {
            this.event('warn', 'recovery-partial',
                `interrupted bar catch-up had ${stats.failed} order(s) the venue rejected; `
                + 'they are recorded as failed and the bar is closed, as a rejection on any other bar would be',
                { barTs: timestamp, data: stats });
        }

        this.writeState({
            lastProcessedBar: timestamp,
            status: this.dryRun ? 'dry-run' : 'complete',
            runId: this.runId,
            intentCount: sourceIntents.length,
            ledger: this.ledger.toJSON(),
            realized: this.realized,
            traded: [...this.traded],
            disowned: [...this.disowned],
            appliedOrderIds: [],
        });
        this.journal.tick(this.runId, {
            ts: timestamp,
            durationMs: 0,
            ...this.lastBatchInfo,
            equity: this.equity,
            sizingEquity: this.totalValue(),
            available: this.availableBalance,
            gross: this.grossExposure(),
            net: this.netExposure(),
            positions: Object.keys(this.stockBalances).length,
            intents: sourceIntents.length,
            ...stats,
            status: 'recovered',
        });
        this.event('info', 'batch-recovered',
            `finished interrupted bar: ${journalledFills + recoveredFills} prior fill(s), ${neverPlaced} never placed, `
                + `${stats.fills} catch-up fill(s)`,
            { barTs: timestamp, data: { journalledFills, recoveredFills, neverPlaced, catchup: stats, fills: fills.length } });
        return { journalledFills, recoveredFills, neverPlaced, intents: intents.length, ...stats };
    }

    async reconcileUnfinalizedOrders({ interruptedBar = null } = {}) {
        const rows = this.journal.unfinalizedOrders(this.runId);
        if (!rows.length) return { repaired: 0, addedQuantity: 0 };

        let repaired = 0;
        let addedQuantity = 0;
        for (const row of rows) {
            const result = await inspectPendingOrder(this.broker, row);
            if (result.outcome !== 'filled') {
                const reason = result.error || result.reason || 'the venue result is still ambiguous';
                this.event('error', 'recovery-blocked',
                    `cannot safely finalize ${row.symbol} order ${row.id}: ${reason}`,
                    { barTs: row.ts, data: result });
                throw new Error(`Unfinalized order ${row.id} could not be reconciled: ${reason}`);
            }

            const finalQty = Number(result.executedQty);
            const journalQty = Math.max(0, Number(row.executed_qty) || 0);
            const markerQty = Number(this.state.reconciledOrderQty?.[row.id]);
            const wasApplied = (this.state.appliedOrderIds || []).map(Number).includes(Number(row.id));
            const interrupted = interruptedBar != null && Number(row.ts) === Number(interruptedBar);
            const previouslyBooked = Number.isFinite(markerQty)
                ? markerQty
                : (interrupted && !wasApplied ? 0 : journalQty);
            const tolerance = 1e-9 * Math.max(1, finalQty, previouslyBooked);
            if (finalQty + tolerance < previouslyBooked) {
                throw new Error(
                    `Venue quantity for order ${row.id} went backwards (${previouslyBooked} to ${finalQty})`,
                );
            }

            const delta = Math.max(0, finalQty - previouslyBooked);
            const reconciledOrderQty = {
                ...(this.state.reconciledOrderQty || {}),
                [row.id]: finalQty,
            };
            if (delta > tolerance) {
                const finalPrice = Number(result.avgPrice);
                const priorPrice = Number(row.avg_price);
                const deltaPrice = finalQty > journalQty && priorPrice > 0
                    ? (finalQty * finalPrice - journalQty * priorPrice) / (finalQty - journalQty)
                    : finalPrice;
                this.recordFill(
                    Number(row.ts),
                    { symbol: row.symbol, price: Number(row.decision_price) || finalPrice },
                    row.side,
                    delta,
                    { executedQty: delta, avgPrice: deltaPrice > 0 ? deltaPrice : finalPrice, status: 'filled' },
                    row.id,
                    { reconciledOrderQty, status: this.state.status },
                );
                addedQuantity += delta;
            } else {
                this.writeState({ reconciledOrderQty });
            }

            this.journal.orderResult(row.id, { ...result.parsed, status: 'filled' }, result.response);
            this.event('info', 'order-reconciled',
                `${row.symbol} order finalized at ${finalQty} of ${row.quantity}; added ${delta} to the owned book`,
                { barTs: row.ts, data: { orderId: row.id, previousQty: journalQty, finalQty, addedQty: delta } });
            repaired++;
        }

        await this.refreshAccount();
        this.flushTradeLogs();
        return { repaired, addedQuantity };
    }

    recordFill(timestamp, intent, side, requestedQty, parsed, orderId = null, statePatch = {}) {
        const quantity = parsed.executedQty > 0 ? Number(parsed.executedQty) : requestedQty;
        const filled = parsed.avgPrice > 0 ? Number(parsed.avgPrice) : null;
        const price = filled ?? intent.price;
        if (filled == null) this.unpricedFills++;
        if (!(quantity > 0) || !(price > 0)) return;
        this.traded.add(intent.symbol);
        const fee = this.fee(intent.symbol, quantity, price, side);
        this.pendingLogs.push({ kind: 'swap', timestamp, stockName: intent.symbol, side, quantity, price, fee });
        const closed = this.ledger.apply({ symbol: intent.symbol, signedQty: side === 'buy' ? quantity : -quantity, price, fee, timestamp });
        this.logHoldings(timestamp);
        if (closed) {
            this.realized += closed.profit;
            this.pendingLogs.push({
                kind: 'trade', timestamp, stockName: intent.symbol, dir: closed.dir,
                profit: closed.profit, profitPercent: closed.profitPercent, holdMs: closed.holdMs,
            });
        }
        const appliedOrderIds = this.state?.appliedOrderIds || [];
        this.writeState({
            status: 'executing',
            ledger: this.ledger.toJSON(),
            realized: this.realized,
            traded: [...this.traded],
            disowned: [...this.disowned],
            appliedOrderIds: orderId == null
                ? appliedOrderIds
                : [...new Set([...appliedOrderIds.map(Number), Number(orderId)])],
            ...statePatch,
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

    async initialize({ interruptedBar = null } = {}) {
        await this.broker.initialize();
        await this.refreshSymbols(true);
        await this.refreshAccount();
        await this.reconcileUnfinalizedOrders({ interruptedBar });
        if (interruptedBar != null) await this.recoverInterruptedBatch(interruptedBar);
        else this.claimExistingPositions();
        this.stream = this.broker.createStream({
            symbols: this.symbols,
            interval: this.interval,
            stepMs: this.stepMs,
            graceMs: this.streamGraceMs,
            settleMs: this.streamSettleMs,
            logger: this.logger,
        });
        this.stream.onCorrection = (correction) => this.applyCandleCorrection(correction);
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
            this.logHoldings(Date.now());
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
        if (!['pause', 'resume', 'stop', 'adjust'].includes(row.command)) {
            this.journal.ackCommands(this.runId, row.id);
            this.lastCommandId = row.id;
            return null;
        }
        return { id: row.id, command: row.command, note: row.note || '', amount: row.amount ?? null };
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

    resumeAllocation() {
        if (Number(this.state.runId) !== this.runId) {
            throw new Error(`Saved runner state belongs to run ${this.state.runId ?? 'unknown'}, not ${this.runId}`);
        }
        if (this.adjustments) this.capital = Math.max(0, this.capital + this.adjustments);
        this.writeState({
            runId: this.runId,
            status: this.state.status === 'executing' ? 'executing' : 'resuming',
        });
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
            if (this.dayOpenEquity > 0) this.dayOpenEquity = Math.max(0, this.dayOpenEquity + applied);
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

    targetLeverage() {
        const cap = Number(this.maxLeverage);
        if (!Number.isFinite(cap) || cap <= 0) return null;
        return Math.max(1, Math.round(cap * LEVERAGE_HEADROOM));
    }

    async ensureLeverage(symbol) {
        if (typeof this.broker.setLeverage !== 'function') return;
        const target = this.targetLeverage();
        if (target == null) return;
        if (this.leverageChecked.has(symbol)) return;
        this.leverageChecked.add(symbol);
        const foreign = (this.lastPortfolio?.positions || []).some(
            (p) => p.symbol === symbol && Number(p.quantity) && !this.ledger.positions[symbol]);
        if (foreign) return;
        try {
            const ceiling = typeof this.broker.maxLeverageFor === 'function'
                ? await this.broker.maxLeverageFor(symbol)
                : null;
            const wanted = Math.max(1, Math.min(target, ceiling > 0 ? ceiling : Infinity, this.accountLeverageCap ?? Infinity));
            const current = this.venueLeverage[symbol] ?? null;
            if (current === wanted) return;
            await this.broker.setLeverage(symbol, wanted);
            this.venueLeverage[symbol] = wanted;
            this.event('info', 'leverage-set',
                `${symbol} venue leverage ${current == null ? 'not reported' : `${current}x`} -> ${wanted}x`,
                { data: { symbol, from: current, to: wanted, target, ceiling } });
        } catch (error) {
            const cap = Number(String(error.message).match(/leverage greater than (\d+)x/i)?.[1]);
            if (cap > 0 && (this.accountLeverageCap == null || cap < this.accountLeverageCap)) {
                this.accountLeverageCap = cap;
                this.event('info', 'leverage-capped', `the account refuses leverage above ${cap}x; using ${cap}x`,
                    { data: { symbol, cap, code: error.code ?? null } });
                this.leverageChecked.delete(symbol);
                return this.ensureLeverage(symbol);
            }
            this.logger.warn(`ForwardRunner: could not set ${symbol} leverage: ${error.message}`);
            this.event('warn', 'leverage-failed', `${symbol} leverage stays as it is: ${error.message}`,
                { data: { symbol, target, code: error.code ?? null } });
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
        const provisional = batch.provisional?.length || 0;
        this.lastBatchInfo = { expected: batch.expected, streamed: batch.candles.length, provisional, recovered: 0, missing: 0 };
        if (!batch.missing.length) return batch.candles;
        const recovered = await this.fetchClosedBatch(batch.timestamp, batch.missing);
        const got = new Set(recovered.map(x => x.symbol));
        const stillMissing = batch.missing.filter(s => !got.has(s));
        if (stillMissing.length / Math.max(1, batch.expected) > this.maxMissingFraction) {
            throw new Error(`Market-data batch ${new Date(batch.timestamp).toISOString()} remains incomplete: ${stillMissing.length}/${batch.expected} symbols missing after history recovery`);
        }
        this.lastBatchInfo = { expected: batch.expected, streamed: batch.candles.length, provisional, recovered: recovered.length, missing: stillMissing.length };
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
        const strategyVersionId = this.journal.strategyVersion({
            name: this.strategy.name,
            market: this.market,
            sourcePath: this.strategy.sourcePath ?? null,
            params: this.strategy.params,
        });
        const config = {
            params: this.strategy.params,
            warmupBars: this.warmupBars,
            market: this.market,
            allowShort: this.allowShort,
            maxLeverage: this.maxLeverage,
            maxNetExposure: Number.isFinite(this.maxNetExposure) ? this.maxNetExposure : null,
            maxOrderNotional: Number.isFinite(this.maxOrderNotional) ? this.maxOrderNotional : null,
            maxOrderAttempts: this.maxOrderAttempts,
            maxMissingFraction: this.maxMissingFraction,
            symbols: this.fixedSymbols,
        };
        const runIdentity = {
            strategy: this.strategy.name,
            broker: this.broker.label,
            account: this.broker.account,
            dryRun: this.dryRun,
            mode: this.dryRun ? 'paper' : this.broker.tradingMode,
            strategyVersionId,
            market: this.market,
            capital: this.capital,
            interval: this.interval,
            config,
        };
        this.runId = this.resumeRunId == null
            ? this.journal.startRun(runIdentity)
            : this.journal.resumeRun({ runId: this.resumeRunId, ...runIdentity });
        if (this.paused) {
            this.journal.record(this.runId, Date.now(), 'paused', { paused: true, note: 'resumed process while paused' });
        }
        let endReason = 'stopped';
        let fatal = null;
        try {
            const interruptedBar = this.resumeRunId != null && this.state.status === 'executing'
                ? Number(this.state.lastProcessedBar) || null
                : null;
            if (this.resumeRunId == null) this.resetAllocation();
            else this.resumeAllocation();
            const latestWarmup = await this.initialize({ interruptedBar });
            if (this.resumeRunId == null) {
                this.baseline = this.totalValue();
                this.journal.baselineEquity(this.runId, this.baseline);
            }
            if (interruptedBar != null) {
                this.logger.warn(`ForwardRunner: recovered interrupted bar ${interruptedBar} against actual venue positions`);
                this.event('info', 'previous-incomplete', 'previous process stopped mid-batch; reconciled and completed from its journalled intents', { barTs: interruptedBar });
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
                let result;
                try {
                    await this.refreshSymbols();
                    if (batch.timestamp <= last) continue;
                    if (batch.timestamp > last + this.stepMs) await this.recoverGap(last, batch.timestamp);
                    const candles = await this.recoverMissing(batch);
                    result = await this.tick(batch.timestamp, candles, {
                        execute: true, paused: this.paused, info: this.lastBatchInfo,
                    });
                    this.consecutiveBarErrors = 0;
                    if (this.logs.ticks) this.logger.log(`ForwardRunner: ${new Date(batch.timestamp).toISOString()} ${candles.length}/${batch.expected} candles (${this.lastBatchInfo?.provisional || 0} provisional), ${result.intents.length} intents, ${result.fills?.length || 0} fills`);
                } catch (err) {
                    if (unrecoverable(err)) throw err;
                    this.consecutiveBarErrors++;
                    this.event('error', 'bar-failed',
                        `${err.message} (${this.consecutiveBarErrors} of ${this.maxConsecutiveBarErrors} before the run gives up)`,
                        { barTs: batch.timestamp, data: { stack: err.stack } });
                    if (this.consecutiveBarErrors >= this.maxConsecutiveBarErrors) {
                        this.haltReason = `${this.consecutiveBarErrors} bars in a row failed: ${err.message}`;
                        await this.refreshAccount().catch(() => {});
                        this.snapshot(batch.timestamp, 'pre');
                        await this.flatten(batch.timestamp, this.haltReason);
                        endReason = 'halted';
                        await this.stop();
                        break;
                    }
                    last = Math.max(last, batch.timestamp);
                    await this.refreshAccount().catch(() => {});
                    continue;
                }
                last = batch.timestamp;
                if (result.halted) endReason = 'halted';
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
            // An ambiguous placement deliberately leaves the run open. The
            // supervisor sees the non-zero exit, reattaches the same run, and
            // resolves its pending venue key before completing the batch.
            if (!fatal?.restartRunner) {
                this.journal.endRun(this.runId, endReason, fatal);
                this.journal.finishRun(this.runId, { finalEquity: this.totalValue() });
            }
            if (this.ownsJournal) this.journal.close();
            this.cache.close();
        }
    }
}
