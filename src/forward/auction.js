import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import RunJournal from '../journal.js';
import Alpaca from '../brokers/alpaca.js';
import withBarCache from './barCache.js';
import { nyDate, tradingSessions } from './nyTime.js';

export { nyOffset, etTime, nyDate, sessionOf, tradingSessions } from './nyTime.js';
export { default as withBarCache } from './barCache.js';

const MIN = 60000;
const DAY = 86400000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const fileSafe = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, '_');
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export default class AuctionRunner {
    constructor({
        strategy,
        broker,
        capital,
        dryRun = false,
        dataDir = 'output/forward',
        journal = null,
        journalFile = 'output/journal.sqlite',
        haltFile = 'output/HALT',
        logger = console,
        dataDelayMs = 15 * MIN,
        decideLeadMs = 14 * MIN,
        prepareLeadMs = 20 * MIN,
        cutoffLeadMs = 10 * MIN,
        exitLeadMs = 15 * MIN,
        opgCutoffLeadMs = 2 * MIN,
        entrySettleMs = 20 * MIN,
        exitSettleMs = 17 * MIN,
        settleTimeoutMs = 60 * MIN,
        pollMs = 20000,
        cashBuffer = 0.995,
        maxOrderNotional = Infinity,
        resumeRunId = null,
        commandPollMs = 5000,
    }) {
        if (!(broker instanceof Alpaca)) throw new TypeError('AuctionRunner needs the Alpaca broker');
        if (!(capital > 0)) throw new TypeError('capital must be a positive number');
        for (const k of ['name', 'topK', 'prepare', 'select']) if (strategy?.[k] == null) throw new TypeError(`strategy.${k} is required`);
        Object.assign(this, {
            strategy, broker, capital, dryRun, haltFile, logger, dataDelayMs, decideLeadMs, prepareLeadMs, cutoffLeadMs,
            exitLeadMs, opgCutoffLeadMs, entrySettleMs, exitSettleMs, settleTimeoutMs, pollMs, cashBuffer,
            maxOrderNotional, commandPollMs,
        });
        this.resumeRunId = resumeRunId == null || resumeRunId === '' ? null : Number(resumeRunId);
        this.lastCommandId = 0;
        this.endReason = 'stopped';
        this.dir = join(dataDir, strategy.name);
        this.stateFile = join(this.dir, `auction-${fileSafe(broker.account)}${dryRun ? '-dry' : ''}.json`);
        this.journal = journal instanceof RunJournal ? journal : new RunJournal({ file: journalFile });
        this.ownsJournal = !(journal instanceof RunJournal);
        this.prefix = `${fileSafe(strategy.name).replace(/_/g, '').slice(0, 12)}${dryRun ? 'd' : ''}`;
        this.stopped = false;
        this.wake = null;
        this.data = withBarCache(broker);
    }

    log(msg) {
        this.logger.log(`[${new Date().toISOString()}] ${this.strategy.name}: ${msg}`);
    }

    event(level, type, message, data) {
        this.journal.event(this.runId, level, type, message, { data });
        this.log(`${level === 'info' ? '' : `${level.toUpperCase()} `}${type}${message ? ` - ${message}` : ''}`);
    }

    loadState() {
        if (existsSync(this.stateFile)) return JSON.parse(readFileSync(this.stateFile, 'utf8'));
        return { runId: null, cash: this.capital, holdings: {}, days: {}, orders: {}, marks: {}, lastEquity: this.capital };
    }

    save() {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state, null, 2));
        renameSync(`${this.stateFile}.tmp`, this.stateFile);
    }

    equity() {
        let v = this.state.cash;
        for (const [sym, h] of Object.entries(this.state.holdings)) v += h.qty * (this.state.marks[sym] ?? h.entryPrice);
        return v;
    }

    portfolio() {
        const positions = Object.entries(this.state.holdings).map(([symbol, h]) => ({
            symbol, quantity: h.qty, markPrice: this.state.marks[symbol] ?? h.entryPrice, entryPrice: h.entryPrice,
        }));
        const equity = this.equity();
        return { cash: this.state.cash, available: this.state.cash, equity, positions };
    }

    dayState(day) {
        return (this.state.days[day] ||= {});
    }

    async until(ts) {
        while (!this.stopped && Date.now() < ts) {
            await new Promise(resolve => {
                const t = setTimeout(resolve, Math.max(0, Math.min(ts - Date.now(), this.commandPollMs)));
                this.wake = () => { clearTimeout(t); resolve(); };
            });
            this.pollCommands();
        }
        this.pollCommands();
        return !this.stopped;
    }

    pollCommands() {
        if (this.runId == null || this.stopped) return;
        const row = this.journal.nextCommand(this.runId, this.lastCommandId);
        if (!row) return;
        this.lastCommandId = row.id;
        this.journal.ackCommands(this.runId, row.id);
        const note = row.note ? `: ${row.note}` : '';
        if (row.command === 'pause' || row.command === 'resume') {
            this.state.paused = row.command === 'pause';
            this.journal.record(this.runId, Date.now(), 'paused', { paused: this.state.paused, note: row.note || '' });
            this.event('warn', row.command, `${row.command}d${note}${this.state.paused ? '; held names still exit at the next open, no new entries' : ''}`);
        } else if (row.command === 'stop') {
            this.state.stopping = true;
            this.event('warn', 'stop', `stop requested${note}; no new entries, the run ends once its names have exited`);
            this.finishIfFlat();
        } else if (row.command === 'adjust') {
            const amount = Number(row.amount);
            if (Number.isFinite(amount) && amount !== 0) {
                this.state.cash += amount;
                this.state.lastEquity += amount;
                this.journal.adjustCapital(this.runId, amount);
                this.journal.record(this.runId, Date.now(), 'allocation', { amount, note: row.note || '' });
                this.event('info', 'adjust', `allocation ${amount > 0 ? '+' : ''}${amount.toFixed(2)}${note}`);
            }
        }
        this.save();
    }

    finishIfFlat() {
        const pending = Object.values(this.state.orders).some(r => r.side === 'buy' && r.status !== 'failed' && !Alpaca.isTerminal(r.status));
        if (!this.state.stopping || Object.keys(this.state.holdings).length || pending) return false;
        this.endReason = 'stopped';
        this.stop();
        return true;
    }

    stop() {
        this.stopped = true;
        this.wake?.();
    }

    async start() {
        this.state = this.loadState();
        const strategyVersionId = this.journal.strategyVersion({
            name: this.strategy.name, market: 'stocks', sourcePath: this.strategy.sourcePath ?? null, params: this.strategy.params ?? null,
        });
        const identity = {
            strategy: this.strategy.name,
            broker: this.broker.label,
            account: this.broker.account,
            dryRun: this.dryRun,
            mode: this.dryRun ? 'paper' : this.broker.tradingMode,
            strategyVersionId,
            market: 'stocks',
            capital: this.capital,
            interval: '1d',
            config: {
                runner: 'auction', params: this.strategy.params ?? null, topK: this.strategy.topK,
                dataDelayMs: this.dataDelayMs, decideLeadMs: this.decideLeadMs, cutoffLeadMs: this.cutoffLeadMs, feed: this.broker.feed,
            },
        };
        const target = this.resumeRunId ?? this.state.runId;
        const known = target != null && this.journal.db.prepare('SELECT id FROM runs WHERE id = ?').get(target);
        if (this.resumeRunId != null && !known) throw new Error(`cannot resume missing run ${this.resumeRunId}`);
        this.runId = known
            ? this.journal.resumeRun({ runId: target, ...identity })
            : this.journal.startRun(identity);
        if (!known) this.journal.baselineEquity(this.runId, this.equity());
        this.state.runId = this.runId;
        this.save();
        const account = await this.broker.getAccount();
        this.event('info', 'start', `${this.dryRun ? 'dry-run' : this.broker.tradingMode} on ${this.broker.label}, equity $${this.equity().toFixed(2)} of account $${Number(account.equity).toFixed(2)}`, {
            holdings: this.state.holdings, accountStatus: account.status,
        });
    }

    async run() {
        await this.start();
        let error = null;
        try {
            while (!this.stopped) {
                const sessions = await this.sessions();
                const session = sessions.find(s => {
                    const ds = this.dayState(s.day);
                    if (ds.done) return false;
                    if (!ds.exit && !ds.entry && Date.now() > s.close - this.cutoffLeadMs) {
                        ds.done = 'skipped';
                        this.event('warn', 'session-skipped', `runner reached ${s.day} after its closing-auction cutoff`);
                        this.save();
                        return false;
                    }
                    return true;
                });
                if (!session) { await this.until(Date.now() + 6 * 3600000); continue; }
                await this.runSession(session);
            }
        } catch (err) {
            this.endReason = 'error';
            error = err;
            this.event('error', 'fatal', err.message, { stack: err.stack });
        } finally {
            this.journal.endRun(this.runId, this.endReason, error);
            this.journal.finishRun(this.runId, { finalEquity: this.equity() });
            if (this.ownsJournal) this.journal.close();
        }
        if (error) throw error;
    }

    sessions() {
        return tradingSessions(this.broker, nyDate(), dayOf(Date.now() + 10 * DAY));
    }

    async runSession(s) {
        const ds = this.dayState(s.day);
        if (!ds.exit) {
            if (!await this.until(s.open - this.exitLeadMs)) return;
            await this.exitPhase(s);
        }
        if (!ds.exitSettled) {
            if (!await this.until(s.open + this.exitSettleMs)) return;
            await this.settle(s, 'exit');
        }
        if (!ds.entry) {
            if (!await this.until(s.close - this.decideLeadMs - this.prepareLeadMs)) return;
            await this.entryPhase(s);
        }
        if (!ds.entrySettled) {
            if (!await this.until(s.close + this.entrySettleMs)) return;
            await this.settle(s, 'entry');
        }
        ds.done = true;
        this.save();
    }

    clientId(day, phase, symbol, attempt = 0) {
        return `${this.prefix}-${phase}-${day}-${symbol}${attempt ? `-${attempt}` : ''}`;
    }

    async submit(s, phase, { symbol, qty, side, timeInForce, decisionPrice, intentId = null, attempt = 0 }) {
        const clientOrderId = this.clientId(s.day, phase, symbol, attempt);
        const orderId = this.journal.orderPending(this.runId, phase === 'x' ? s.open : s.close, {
            intentId, symbol, side, quantity: qty, reduceOnly: side === 'sell', clientOrderId, decisionPrice,
        });
        const rec = { orderId, symbol, side, qty, day: s.day, phase, timeInForce, decisionPrice, status: 'pending', filledQty: 0, avgPrice: null, applied: 0 };
        this.state.orders[clientOrderId] = rec;
        this.save();
        if (this.dryRun) {
            rec.status = 'accepted';
            this.journal.orderResult(orderId, { status: 'accepted' }, { dryRun: true });
            this.save();
            return rec;
        }
        try {
            const res = await this.broker.submitOrder({ symbol, qty, side, timeInForce, clientOrderId });
            this.applyOrder(clientOrderId, res);
        } catch (err) {
            const existing = await this.broker.getOrderByClientId(clientOrderId).catch(() => null);
            if (existing) this.applyOrder(clientOrderId, existing);
            else {
                rec.status = 'failed';
                rec.error = err.message;
                this.journal.orderFailed(orderId, err);
                this.event('warn', 'order-failed', `${side} ${qty} ${symbol} ${timeInForce}: ${err.message}`);
            }
        }
        this.save();
        return rec;
    }

    applyOrder(clientOrderId, res) {
        const rec = this.state.orders[clientOrderId];
        rec.status = String(res.status);
        rec.exchangeOrderId = res.id;
        rec.filledQty = Number(res.filled_qty) || 0;
        rec.avgPrice = res.filled_avg_price != null ? Number(res.filled_avg_price) : null;
        this.journal.orderResult(rec.orderId, {
            status: rec.status, exchangeOrderId: res.id, executedQty: rec.filledQty, avgPrice: rec.avgPrice,
        }, res);
        this.applyFill(rec);
    }

    applyFill(rec) {
        const delta = rec.filledQty - rec.applied;
        if (!(delta > 0) || !(rec.avgPrice > 0)) return;
        const fee = this.broker.calculateFees(delta, rec.avgPrice, rec.side);
        if (rec.side === 'buy') {
            const h = this.state.holdings[rec.symbol] || { qty: 0, entryPrice: 0, day: rec.day, cost: 0 };
            h.cost += delta * rec.avgPrice + fee;
            h.qty += delta;
            h.entryPrice = h.cost / h.qty;
            this.state.holdings[rec.symbol] = h;
            this.state.cash -= delta * rec.avgPrice + fee;
            this.state.marks[rec.symbol] = rec.avgPrice;
        } else {
            const h = this.state.holdings[rec.symbol];
            this.state.cash += delta * rec.avgPrice - fee;
            if (h) {
                const exitCost = h.cost * (delta / h.qty);
                rec.pnl = (rec.pnl || 0) + delta * rec.avgPrice - fee - exitCost;
                h.cost -= exitCost;
                h.qty -= delta;
                if (h.qty <= 1e-9) { delete this.state.holdings[rec.symbol]; delete this.state.marks[rec.symbol]; }
            }
        }
        rec.applied = rec.filledQty;
    }

    liveSell(symbol) {
        return Object.values(this.state.orders).some(r => r.symbol === symbol && r.side === 'sell'
            && r.status !== 'failed' && !Alpaca.isTerminal(r.status));
    }

    async exitPhase(s) {
        const ds = this.dayState(s.day);
        const held = Object.entries(this.state.holdings).filter(([symbol]) => !this.liveSell(symbol));
        const late = !this.dryRun && Date.now() > s.open - this.opgCutoffLeadMs;
        if (late && held.length) {
            if (Date.now() > s.close - 15 * MIN) {
                this.event('warn', 'exit-deferred', `too late to sell ${held.map(x => x[0]).join(', ')} on ${s.day}`);
                ds.exit = 'deferred';
                this.save();
                return;
            }
            if (!await this.until(s.open + MIN)) return;
        }
        for (const [symbol, h] of held) {
            await this.submit(s, 'x', { symbol, qty: h.qty, side: 'sell', timeInForce: late ? 'day' : 'opg', decisionPrice: this.state.marks[symbol] ?? h.entryPrice });
        }
        if (held.length) this.event('info', 'exit-submitted', `${held.length} ${late ? 'market (late)' : 'opening-auction'} sells`, { symbols: held.map(x => x[0]) });
        ds.exit = true;
        this.save();
    }

    async settle(s, phase) {
        const ds = this.dayState(s.day);
        const code = phase === 'exit' ? 'x' : 'e';
        const recs = () => Object.entries(this.state.orders).filter(([, r]) => r.day === s.day && r.phase === code);
        if (this.dryRun) await this.simulateFills(s, phase, recs().map(([, r]) => r));
        const deadline = Date.now() + this.settleTimeoutMs;
        while (!this.dryRun && !this.stopped) {
            let open = 0;
            for (const [cid, r] of Object.entries(this.state.orders)) {
                if (r.status === 'failed' || Alpaca.isTerminal(r.status)) continue;
                const res = await this.broker.getOrderByClientId(cid);
                if (res) this.applyOrder(cid, res);
                if (!Alpaca.isTerminal(r.status) && r.day === s.day && r.phase === code) open++;
            }
            this.save();
            if (!open || Date.now() > deadline) break;
            await sleep(this.pollMs);
        }
        if (this.stopped) return;
        const rows = recs().map(([, r]) => r);
        const fills = rows.filter(r => r.filledQty > 0).length;
        if (!this.dryRun && fills) await this.auctionCheck(s, phase, rows.filter(r => r.filledQty > 0)).catch(err => this.event('warn', 'auction-check-failed', err.message));
        if (phase === 'exit') {
            const stuck = Object.keys(this.state.holdings);
            if (stuck.length) this.event('warn', 'exit-incomplete', `still holding ${stuck.join(', ')}; retried at the next session's exit`, { orders: rows });
            const pnl = rows.reduce((a, r) => a + (r.pnl || 0), 0);
            const before = this.state.lastEquity;
            const eq = this.equity();
            if (rows.length) {
                this.journal.record(this.runId, s.open, 'night', {
                    value: before > 0 ? eq / before - 1 : null, pnl, equity: eq,
                    fills: rows.map(r => ({ symbol: r.symbol, qty: r.filledQty, price: r.avgPrice, pnl: r.pnl ?? null, status: r.status })),
                });
            }
            this.state.lastEquity = eq;
            ds.exitSettled = true;
            this.snapshot(s.open, 'exit', rows.length, fills);
            this.save();
            if (this.finishIfFlat()) return;
        } else {
            const missed = rows.filter(r => !(r.filledQty > 0));
            if (missed.length) this.event('warn', 'entry-unfilled', missed.map(r => `${r.symbol} ${r.status}`).join(', '));
            this.state.lastEquity = this.equity();
            ds.entrySettled = true;
            this.snapshot(s.close, 'entry', rows.length, fills);
        }
        this.save();
    }

    snapshot(ts, phase, orders, fills) {
        const p = this.portfolio();
        this.journal.snapshot(this.runId, ts, phase, p);
        this.journal.tick(this.runId, {
            ts, equity: p.equity, sizingEquity: p.equity, available: p.cash, gross: p.positions.reduce((a, x) => a + x.quantity * x.markPrice, 0),
            net: p.positions.reduce((a, x) => a + x.quantity * x.markPrice, 0), positions: p.positions.length,
            orders, fills, status: 'ok',
        });
        this.log(`${phase} settled: equity $${p.equity.toFixed(2)}, ${p.positions.length} positions, ${fills}/${orders} filled`);
    }

    async auctionCheck(s, phase, rows) {
        const px = await this.broker.bars([...new Set(rows.map(r => r.symbol))], {
            timeframe: '1Day', start: s.day, end: new Date(Date.now() - this.dataDelayMs).toISOString(),
        });
        const out = [];
        for (const r of rows) {
            const bar = (px.get(r.symbol) || []).find(b => nyDate(b.t) === s.day);
            const official = bar ? (phase === 'exit' ? bar.o : bar.c) : null;
            const bps = official > 0 ? (r.avgPrice / official - 1) * 1e4 * (r.side === 'buy' ? 1 : -1) : null;
            out.push({ symbol: r.symbol, side: r.side, fill: r.avgPrice, official, costBps: bps });
            this.journal.record(this.runId, phase === 'exit' ? s.open : s.close, 'auction-check', { symbol: r.symbol, value: bps, side: r.side, fill: r.avgPrice, official });
        }
        const known = out.filter(x => Number.isFinite(x.costBps));
        if (known.length) this.log(`${phase} fills vs official ${phase === 'exit' ? 'open' : 'close'}: mean ${(known.reduce((a, x) => a + x.costBps, 0) / known.length).toFixed(1)}bps against us over ${known.length}`);
    }

    async simulateFills(s, phase, recs) {
        if (!recs.length) return;
        const px = await this.broker.bars([...new Set(recs.map(r => r.symbol))], {
            timeframe: '1Day', start: s.day, end: new Date(Math.min(Date.now() - this.dataDelayMs, s.close + 6 * 3600000)).toISOString(),
        });
        for (const r of recs) {
            const bar = (px.get(r.symbol) || []).find(b => nyDate(b.t) === s.day);
            const price = bar ? (phase === 'exit' ? bar.o : bar.c) : null;
            r.status = price ? 'filled' : 'expired';
            r.filledQty = price ? r.qty : 0;
            r.avgPrice = price;
            this.journal.orderResult(r.orderId, { status: r.status, executedQty: r.filledQty, avgPrice: price }, { simulated: true, bar });
            this.applyFill(r);
        }
        this.save();
    }

    async entryPhase(s) {
        const ds = this.dayState(s.day);
        const decideAt = s.close - this.decideLeadMs;
        const cutoff = s.close - this.cutoffLeadMs;
        if (Date.now() > cutoff) {
            ds.entry = 'missed';
            this.event('warn', 'entry-missed', `runner reached ${s.day} after the closing-auction cutoff`);
            this.save();
            return;
        }
        if (this.state.paused || this.state.stopping) {
            ds.entry = this.state.stopping ? 'stopping' : 'paused';
            this.event('info', 'entry-skipped', `run is ${ds.entry}; no new positions on ${s.day}`);
            this.save();
            return;
        }
        if (existsSync(this.haltFile)) {
            ds.entry = 'halted';
            this.event('warn', 'entry-halted', `${this.haltFile} exists; no new positions`);
            this.save();
            return;
        }
        const prepStart = Date.now();
        const prepared = await this.strategy.prepare({ broker: this.data, session: s, logger: this.logger });
        this.log(`prepared ${s.day} in ${((Date.now() - prepStart) / 1000).toFixed(0)}s`);
        if (!await this.until(decideAt)) return;
        const equity = this.equity();
        const clip = Math.min(equity / this.strategy.topK, this.maxOrderNotional);
        const asOf = Date.now() - this.dataDelayMs;
        const picks = await this.strategy.select({ broker: this.data, prepared, session: s, asOf, clip, logger: this.logger });
        const chosen = picks.slice(0, this.strategy.topK);
        this.journal.record(this.runId, s.close, 'picks', { equity, clip, asOf, picks: chosen, universe: prepared?.stats ?? null });
        if (Date.now() > cutoff) {
            ds.entry = 'missed';
            this.event('warn', 'entry-missed', `selection finished after the cutoff (${new Date(Date.now()).toISOString()})`, { picks: chosen });
            this.save();
            return;
        }
        let cash = this.state.cash;
        for (const p of chosen) {
            const budget = Math.min(clip, cash) * this.cashBuffer;
            const qty = Math.floor(budget / p.price);
            if (!(qty > 0)) continue;
            const intentId = this.journal.intent(this.runId, s.close, { symbol: p.symbol, signedQty: qty, price: p.price, heldQty: this.state.holdings[p.symbol]?.qty ?? 0, sizingEquity: equity });
            await this.submit(s, 'e', { symbol: p.symbol, qty, side: 'buy', timeInForce: 'cls', decisionPrice: p.price, intentId });
            cash -= qty * p.price;
        }
        ds.entry = true;
        this.event('info', 'entry-submitted', `${chosen.length} closing-auction buys: ${chosen.map(p => p.symbol).join(' ')}`, { picks: chosen });
        this.save();
    }
}

function replayMetrics(curve, capital, fees, trades, from, to) {
    const eq = [capital, ...curve.map(c => c[1])];
    const rets = [];
    for (let i = 1; i < eq.length; i++) rets.push(eq[i] / eq[i - 1] - 1);
    const n = rets.length || 1;
    const mean = rets.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const geo = Math.exp(rets.reduce((a, b) => a + Math.log(1 + b), 0) / n) - 1;
    let peak = eq[0], maxDD = 0;
    for (const v of eq) { if (v > peak) peak = v; maxDD = Math.min(maxDD, v / peak - 1); }
    const totalReturn = eq.at(-1) / capital - 1;
    const years = (to - from) / (365 * DAY);
    return {
        period: [new Date(from), new Date(to)], trades, totalFees: fees, totalReturn, netDeposits: 0,
        avgDaily: mean, geoDaily: geo, dailyWinRate: rets.filter(r => r > 0).length / n, days: rets.length,
        CAGR: years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0,
        sharpe: sd ? (mean / sd) * Math.sqrt(252) : 0, maxDrawdown: maxDD,
        geoPeriodRet: geo, geoAnnualRet: Math.pow(1 + geo, 252) - 1,
        featureCorrelations: null, totalFunding: 0, ruined: false,
    };
}

export async function replayAuction({
    strategy, broker, capital, from, to, journal = null, logger = console,
    decideLeadMs = 14 * MIN, dataDelayMs = 15 * MIN, cashBuffer = 0.995, maxOrderNotional = Infinity,
}) {
    const today = nyDate();
    const all = await tradingSessions(broker, from, dayOf(Math.min(Date.parse(`${to}T00:00:00Z`) + 10 * DAY, Date.now())));
    const sessions = all.filter(s => s.day <= to && s.day < today);
    if (!sessions.length) throw new Error(`no completed sessions between ${from} and ${to}`);
    const exitSession = all.find(s => s.day > sessions.at(-1).day && s.open + dataDelayMs < Date.now()) || null;
    const lastData = exitSession ?? sessions.at(-1);
    const data = withBarCache(broker, { horizon: lastData.day, memoAssets: true });
    const ownsJournal = !(journal instanceof RunJournal);
    if (ownsJournal) journal = new RunJournal({ file: 'output/journal.sqlite' });
    const runId = journal.startRun({
        strategy: strategy.name, broker: broker.label, account: broker.account, dryRun: 0, mode: 'backtest',
        strategyVersionId: journal.strategyVersion({ name: strategy.name, market: 'stocks', sourcePath: strategy.sourcePath ?? null, params: strategy.params ?? null }),
        market: 'stocks', capital, interval: '1d', windowStart: sessions[0].open, windowEnd: sessions.at(-1).close,
        config: { runner: 'auction', params: strategy.params ?? null, topK: strategy.topK, replay: true },
    });
    journal.snapshot(runId, sessions[0].open, 'start', { cash: capital, equity: capital, positions: [] });

    let cash = capital, fees = 0, trades = 0, lastEquity = capital;
    let holdings = [];
    const curve = [];
    const official = async (symbols, day) => {
        const px = symbols.length ? await data.bars(symbols, { timeframe: '1Day', start: day, end: day }) : new Map();
        return (sym) => (px.get(sym) || []).find(b => nyDate(b.t) === day) || null;
    };
    const order = (ts, symbol, side, qty, decision, price, intentId = null) => {
        const id = journal.insertOrder(runId, ts, { intentId, symbol, side, quantity: qty, reduceOnly: side === 'sell', decisionPrice: decision }, 'pending');
        journal.orderResult(id, { status: price ? 'filled' : 'expired', executedQty: price ? qty : 0, avgPrice: price }, { replay: true });
    };
    const exitAt = async (s) => {
        if (!holdings.length) return;
        const bar = await official(holdings.map(h => h.symbol), s.day);
        const kept = [], fills = [];
        let pnl = 0;
        for (const h of holdings) {
            const b = bar(h.symbol);
            if (!(b?.o > 0)) { kept.push(h); continue; }
            const fee = broker.calculateFees(h.qty, b.o, 'sell');
            cash += h.qty * b.o - fee;
            fees += fee; trades++;
            pnl += h.qty * b.o - fee - h.cost;
            fills.push({ symbol: h.symbol, qty: h.qty, price: b.o, ret: b.o / h.entry - 1 });
            order(s.open, h.symbol, 'sell', h.qty, h.entry, b.o);
        }
        holdings = kept;
        const eq = cash + holdings.reduce((a, h) => a + h.qty * h.entry, 0);
        journal.record(runId, s.open, 'night', { value: lastEquity > 0 ? eq / lastEquity - 1 : null, pnl, equity: eq, fills });
        lastEquity = eq;
    };

    const quiet = { log() {} };
    const started = Date.now();
    try {
        for (const [i, s] of sessions.entries()) {
            await exitAt(s);
            const equity = cash + holdings.reduce((a, h) => a + h.qty * h.entry, 0);
            const clip = Math.min(equity / strategy.topK, maxOrderNotional);
            const prepared = await strategy.prepare({ broker: data, session: s, logger: quiet });
            const asOf = s.close - decideLeadMs - dataDelayMs;
            const picks = (await strategy.select({ broker: data, prepared, session: s, asOf, clip, logger: quiet })).slice(0, strategy.topK);
            journal.record(runId, s.close, 'picks', { equity, clip, picks });
            const bar = await official(picks.map(p => p.symbol), s.day);
            let left = cash;
            for (const p of picks) {
                const qty = Math.floor((Math.min(clip, left) * cashBuffer) / p.price);
                if (!(qty > 0)) continue;
                const b = bar(p.symbol);
                const intentId = journal.intent(runId, s.close, { symbol: p.symbol, signedQty: qty, price: p.price, heldQty: 0, sizingEquity: equity });
                if (!(b?.c > 0)) { order(s.close, p.symbol, 'buy', qty, p.price, null, intentId); continue; }
                const fee = broker.calculateFees(qty, b.c, 'buy');
                cash -= qty * b.c + fee;
                left -= qty * p.price;
                fees += fee; trades++;
                holdings.push({ symbol: p.symbol, qty, entry: b.c, cost: qty * b.c + fee });
                order(s.close, p.symbol, 'buy', qty, p.price, b.c, intentId);
            }
            const eq = cash + holdings.reduce((a, h) => a + h.qty * h.entry, 0);
            lastEquity = eq;
            curve.push([s.close, eq]);
            journal.tick(runId, { ts: s.close, equity: eq, available: cash, positions: holdings.length, orders: picks.length, fills: holdings.length, status: 'complete' });
            logger.log(`${s.day} ${String(i + 1).padStart(4)}/${sessions.length}  equity ${eq.toFixed(2)}  ${picks.map(p => p.symbol).join(' ')}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
        }
        if (exitSession) {
            await exitAt(exitSession);
            curve[curve.length - 1] = [curve.at(-1)[0], cash + holdings.reduce((a, h) => a + h.qty * h.entry, 0)];
        }
        const metrics = replayMetrics(curve, capital, fees, trades, sessions[0].open, sessions.at(-1).close);
        const final = curve.at(-1)[1];
        journal.snapshot(runId, sessions.at(-1).close, 'end', {
            cash, equity: final, positions: holdings.map(h => ({ symbol: h.symbol, quantity: h.qty, markPrice: h.entry, entryPrice: h.entry })),
        });
        journal.finishRun(runId, { finalEquity: final, metrics });
        journal.endRun(runId, 'complete');
        return { runId, metrics };
    } catch (err) {
        journal.endRun(runId, 'error', err);
        throw err;
    } finally {
        if (ownsJournal) journal.close();
    }
}
