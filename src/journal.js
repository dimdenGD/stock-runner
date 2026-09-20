import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT,
    error TEXT,
    strategy TEXT NOT NULL,
    broker TEXT,
    account TEXT,
    dry_run INTEGER NOT NULL DEFAULT 0,
    capital REAL,
    interval TEXT,
    config TEXT,
    git_commit TEXT,
    git_dirty INTEGER,
    host TEXT,
    pid INTEGER,
    node TEXT,
    mode TEXT NOT NULL DEFAULT 'live',
    strategy_version_id INTEGER,
    market TEXT,
    window_start INTEGER,
    window_end INTEGER,
    final_equity REAL,
    metrics TEXT,
    baseline_equity REAL,
    adjustments REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS strategies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    market TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS strategy_versions (
    id INTEGER PRIMARY KEY,
    strategy_id INTEGER NOT NULL,
    hash TEXT NOT NULL,
    source TEXT,
    source_path TEXT,
    params TEXT,
    message TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (strategy_id, hash)
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    run_id INTEGER,
    at INTEGER NOT NULL,
    bar_ts INTEGER,
    level TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT,
    data TEXT
);
CREATE TABLE IF NOT EXISTS ticks (
    run_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    processed_at INTEGER NOT NULL,
    duration_ms INTEGER,
    expected INTEGER,
    streamed INTEGER,
    recovered INTEGER,
    missing INTEGER,
    equity REAL,
    sizing_equity REAL,
    available REAL,
    gross REAL,
    net REAL,
    positions INTEGER,
    intents INTEGER,
    orders INTEGER,
    fills INTEGER,
    skipped INTEGER,
    failed INTEGER,
    status TEXT NOT NULL,
    PRIMARY KEY (run_id, ts)
);
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    ts INTEGER,
    at INTEGER NOT NULL,
    phase TEXT NOT NULL,
    cash REAL,
    available REAL,
    equity REAL,
    gross REAL,
    net REAL
);
CREATE TABLE IF NOT EXISTS positions (
    snapshot_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    quantity REAL NOT NULL,
    mark_price REAL,
    entry_price REAL,
    unrealized_pnl REAL,
    PRIMARY KEY (snapshot_id, symbol)
);
CREATE TABLE IF NOT EXISTS intents (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    signed_qty REAL NOT NULL,
    price REAL,
    held_qty REAL,
    notional REAL,
    sizing_equity REAL
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    intent_id INTEGER,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity REAL,
    reduce_only INTEGER NOT NULL DEFAULT 0,
    client_order_id TEXT,
    decision_price REAL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    exchange_order_id TEXT,
    executed_qty REAL,
    avg_price REAL,
    error_code TEXT,
    error TEXT,
    response TEXT
);
CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    symbol TEXT,
    value REAL,
    data TEXT
);
CREATE TABLE IF NOT EXISTS income (
    account TEXT NOT NULL,
    id TEXT NOT NULL,
    time INTEGER NOT NULL,
    symbol TEXT,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    asset TEXT,
    info TEXT,
    trade_id TEXT,
    run_id INTEGER,
    PRIMARY KEY (account, id)
);
CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    at INTEGER NOT NULL,
    command TEXT NOT NULL,
    note TEXT,
    amount REAL,
    acted_at INTEGER
);
CREATE INDEX IF NOT EXISTS commands_run ON commands (run_id, id);
CREATE INDEX IF NOT EXISTS runs_mode ON runs (mode, started_at);
CREATE INDEX IF NOT EXISTS runs_strategy ON runs (strategy, started_at);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, at);
CREATE INDEX IF NOT EXISTS snapshots_run ON snapshots (run_id, ts);
CREATE INDEX IF NOT EXISTS intents_run ON intents (run_id, ts);
CREATE INDEX IF NOT EXISTS orders_run ON orders (run_id, ts);
CREATE INDEX IF NOT EXISTS orders_symbol ON orders (symbol, ts);
CREATE INDEX IF NOT EXISTS records_run ON records (run_id, ts, kind);
CREATE INDEX IF NOT EXISTS income_time ON income (account, time);
CREATE VIEW IF NOT EXISTS v_orders AS
SELECT o.*,
    datetime(o.ts / 1000, 'unixepoch') AS bar_time,
    r.strategy,
    CASE WHEN o.avg_price > 0 AND o.decision_price > 0 THEN
        CASE o.side WHEN 'buy' THEN (o.avg_price / o.decision_price - 1) * 1e4
        ELSE (1 - o.avg_price / o.decision_price) * 1e4 END
    END AS slippage_bps,
    o.executed_qty * o.avg_price AS filled_notional
FROM orders o JOIN runs r ON r.id = o.run_id;
CREATE VIEW IF NOT EXISTS v_ticks AS
SELECT t.*, datetime(t.ts / 1000, 'unixepoch') AS bar_time, r.strategy
FROM ticks t JOIN runs r ON r.id = t.run_id;
`;

const MIGRATIONS = [
    ['runs', 'mode', "TEXT NOT NULL DEFAULT 'live'"],
    ['runs', 'strategy_version_id', 'INTEGER'],
    ['runs', 'market', 'TEXT'],
    ['runs', 'window_start', 'INTEGER'],
    ['runs', 'window_end', 'INTEGER'],
    ['runs', 'final_equity', 'REAL'],
    ['runs', 'metrics', 'TEXT'],
    ['runs', 'baseline_equity', 'REAL'],
    ['runs', 'adjustments', 'REAL NOT NULL DEFAULT 0'],
    ['commands', 'amount', 'REAL'],
];

const json = (value) => (value === undefined ? null : JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

function git(args) {
    try {
        return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

export default class RunJournal {
    constructor({ file = 'output/forward.sqlite' } = {}) {
        if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
        this.file = file;
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
        this.db.exec(SCHEMA);
        this.migrate();
        const prepare = (sql) => this.db.prepare(sql);
        this.sql = {
            startRun: prepare(`INSERT INTO runs (started_at, strategy, broker, account, dry_run, capital, interval, config, git_commit, git_dirty, host, pid, node, mode, strategy_version_id, market, window_start, window_end)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
            resumeTarget: prepare(`SELECT id, strategy, account, dry_run, mode, git_commit, git_dirty,
                    strategy_version_id, ended_at, end_reason
                FROM runs WHERE id = ?`),
            resumeRun: prepare(`UPDATE runs SET ended_at = NULL, end_reason = NULL, error = NULL,
                    final_equity = NULL, config = ?, git_commit = ?, git_dirty = ?, host = ?, pid = ?, node = ?,
                    strategy_version_id = ?
                WHERE id = ?`),
            endRun: prepare('UPDATE runs SET ended_at = ?, end_reason = ?, error = ? WHERE id = ? AND ended_at IS NULL'),
            finishRun: prepare('UPDATE runs SET final_equity = ?, metrics = ? WHERE id = ?'),
            baselineEquity: prepare('UPDATE runs SET baseline_equity = ? WHERE id = ? AND baseline_equity IS NULL'),
            adjustCapital: prepare('UPDATE runs SET adjustments = COALESCE(adjustments, 0) + ? WHERE id = ?'),
            previousRun: prepare(`SELECT id, end_reason, ended_at FROM runs
                WHERE strategy = ? AND account = ? AND dry_run = ? AND id < ? AND mode != 'backtest'
                ORDER BY id DESC LIMIT 1`),
            findStrategy: prepare('SELECT id FROM strategies WHERE name = ?'),
            insertStrategy: prepare('INSERT INTO strategies (name, market, created_at) VALUES (?, ?, ?)'),
            findVersion: prepare('SELECT id FROM strategy_versions WHERE strategy_id = ? AND hash = ?'),
            insertVersion: prepare(`INSERT INTO strategy_versions (strategy_id, hash, source, source_path, params, message, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`),
            event: prepare('INSERT INTO events (run_id, at, bar_ts, level, type, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)'),
            tick: prepare(`INSERT OR REPLACE INTO ticks (run_id, ts, processed_at, duration_ms, expected, streamed, recovered, missing, equity, sizing_equity, available, gross, net, positions, intents, orders, fills, skipped, failed, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
            snapshot: prepare('INSERT INTO snapshots (run_id, ts, at, phase, cash, available, equity, gross, net) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
            position: prepare('INSERT INTO positions (snapshot_id, symbol, quantity, mark_price, entry_price, unrealized_pnl) VALUES (?, ?, ?, ?, ?, ?)'),
            intent: prepare('INSERT INTO intents (run_id, ts, symbol, signed_qty, price, held_qty, notional, sizing_equity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
            order: prepare(`INSERT INTO orders (run_id, ts, intent_id, symbol, side, quantity, reduce_only, client_order_id, decision_price, status, created_at, updated_at, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
            orderResult: prepare(`UPDATE orders SET status = ?, updated_at = ?, exchange_order_id = ?, executed_qty = ?, avg_price = ?, response = ? WHERE id = ?`),
            orderFailed: prepare('UPDATE orders SET status = ?, updated_at = ?, error_code = ?, error = ?, response = ? WHERE id = ?'),
            pendingOrdersAt: prepare(`SELECT id, ts, symbol, side, quantity, reduce_only,
                    client_order_id, exchange_order_id, decision_price, created_at, updated_at
                FROM orders WHERE run_id = ? AND ts = ? AND status = 'pending'
                ORDER BY id ASC`),
            answeredOrdersAt: prepare(`SELECT id, ts, symbol, side, quantity, decision_price,
                    exchange_order_id, executed_qty, avg_price, status
                FROM orders
                WHERE run_id = ? AND ts = ? AND status NOT IN ('pending', 'failed', 'skipped')
                ORDER BY id ASC`),
            intentsAt: prepare(`SELECT id, symbol, signed_qty, price, held_qty
                FROM intents WHERE run_id = ? AND ts = ? ORDER BY id ASC`),
            record: prepare('INSERT INTO records (run_id, ts, kind, symbol, value, data) VALUES (?, ?, ?, ?, ?, ?)'),
            insertCommand: prepare('INSERT INTO commands (run_id, at, command, note, amount) VALUES (?, ?, ?, ?, ?)'),
            nextCommand: prepare('SELECT id, command, note, amount, at FROM commands WHERE run_id = ? AND id > ? ORDER BY id DESC LIMIT 1'),
            ackCommands: prepare('UPDATE commands SET acted_at = ? WHERE run_id = ? AND id <= ? AND acted_at IS NULL'),
            pendingCommand: prepare('SELECT id, command, note, amount, at FROM commands WHERE run_id = ? AND acted_at IS NULL ORDER BY id DESC LIMIT 1'),
            lastIncome: prepare('SELECT MAX(time) AS time FROM income WHERE account = ?'),
            income: prepare(`INSERT OR IGNORE INTO income (account, id, time, symbol, type, amount, asset, info, trade_id, run_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        };
    }

    migrate() {
        for (const [table, column, type] of MIGRATIONS) {
            const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
            if (cols.some(c => c.name === column)) continue;
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
    }

    batchBegin(size = 2000) {
        if (this._batch != null) return;
        this._batchSize = size;
        this._batch = 0;
        this.db.exec('BEGIN');
    }

    batchStep(n = 1) {
        if (this._batch == null) return;
        this._batch += n;
        if (this._batch < this._batchSize) return;
        this.db.exec('COMMIT');
        this.db.exec('BEGIN');
        this._batch = 0;
    }

    batchFlush() {
        if (this._batch == null) return;
        this.db.exec('COMMIT');
        this.db.exec('BEGIN');
        this._batch = 0;
    }

    batchEnd() {
        if (this._batch == null) return;
        this.db.exec('COMMIT');
        this._batch = null;
    }

    transaction(fn) {
        if (this._batch != null) return fn();
        this.db.exec('BEGIN');
        try {
            const out = fn();
            this.db.exec('COMMIT');
            return out;
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    strategyVersion({ name, market = null, source = null, sourcePath = null, params = null, message = null }) {
        if (!name) return null;
        let text = source;
        if (text == null && sourcePath) {
            try { text = readFileSync(sourcePath, 'utf8'); } catch { text = null; }
        }
        const hash = createHash('sha256')
            .update(text ?? `${name} ${json(params) ?? ''}`)
            .digest('hex');
        return this.transaction(() => {
            let strategyId = this.sql.findStrategy.get(name)?.id;
            if (strategyId == null) {
                strategyId = Number(this.sql.insertStrategy.run(name, market, Date.now()).lastInsertRowid);
            }
            const existing = this.sql.findVersion.get(strategyId, hash);
            if (existing) return Number(existing.id);
            return Number(this.sql.insertVersion.run(
                strategyId, hash, text, sourcePath, json(params), message, Date.now(),
            ).lastInsertRowid);
        });
    }

    startRun({
        strategy, broker, account, dryRun, capital, interval, config,
        mode = 'live', strategyVersionId = null, market = null, windowStart = null, windowEnd = null,
    }) {
        const commit = git(['rev-parse', 'HEAD']);
        const dirty = commit === null ? null : (git(['status', '--porcelain']) ? 1 : 0);
        const result = this.sql.startRun.run(
            Date.now(), strategy, broker ?? null, account ?? null, dryRun ? 1 : 0,
            Number.isFinite(capital) ? capital : null, interval ?? null, json(config),
            commit, dirty, hostname(), process.pid, process.version,
            mode, strategyVersionId, market, windowStart, windowEnd,
        );
        return Number(result.lastInsertRowid);
    }

    resumeRun({ runId, strategy, account, dryRun, mode, strategyVersionId = null, config = null }) {
        const id = Number(runId);
        const target = this.sql.resumeTarget.get(id);
        if (!target) throw new Error(`Cannot resume missing run ${runId}`);
        if (target.strategy !== strategy || target.account !== account
            || Boolean(target.dry_run) !== Boolean(dryRun) || target.mode !== mode) {
            throw new Error(`Cannot resume run ${runId}: strategy, account or mode does not match`);
        }
        const commit = git(['rev-parse', 'HEAD']);
        const dirty = commit === null ? null : (git(['status', '--porcelain']) ? 1 : 0);
        this.sql.resumeRun.run(
            json(config), commit, dirty, hostname(), process.pid, process.version,
            strategyVersionId, id,
        );
        this.event(id, 'info', 'process-updated', 'runner process replaced without ending the run', {
            data: {
                previous: {
                    gitCommit: target.git_commit,
                    gitDirty: target.git_dirty,
                    strategyVersionId: target.strategy_version_id,
                    endedAt: target.ended_at,
                    endReason: target.end_reason,
                },
                current: { gitCommit: commit, gitDirty: dirty, strategyVersionId, pid: process.pid },
            },
        });
        return id;
    }

    baselineEquity(runId, equity) {
        if (runId == null) return;
        this.sql.baselineEquity.run(num(equity), runId);
    }

    /** Money added to or taken out of a run's allocation, which is not P&L. */
    adjustCapital(runId, amount) {
        if (runId == null || !Number.isFinite(Number(amount))) return;
        this.sql.adjustCapital.run(Number(amount), runId);
    }

    previousRun({ strategy, account, dryRun = false, before }) {
        const row = this.sql.previousRun.get(
            String(strategy), account ?? null, dryRun ? 1 : 0, Number(before));
        return row ? { id: row.id, endReason: row.end_reason, endedAt: row.ended_at } : null;
    }

    finishRun(runId, { finalEquity = null, metrics = null } = {}) {
        if (runId == null) return;
        this.sql.finishRun.run(num(finalEquity), json(metrics), runId);
    }

    endRun(runId, reason, error = null) {
        if (runId == null) return;
        this.sql.endRun.run(Date.now(), reason, error ? String(error.stack || error.message || error) : null, runId);
    }

    event(runId, level, type, message = null, { barTs = null, data } = {}) {
        this.sql.event.run(runId ?? null, Date.now(), barTs, level, type, message, json(data));
    }

    tick(runId, t) {
        this.sql.tick.run(
            runId, t.ts, Date.now(), t.durationMs ?? null, t.expected ?? null, t.streamed ?? null, t.recovered ?? null, t.missing ?? null,
            num(t.equity), num(t.sizingEquity), num(t.available), num(t.gross), num(t.net), t.positions ?? null,
            t.intents ?? 0, t.orders ?? 0, t.fills ?? 0, t.skipped ?? 0, t.failed ?? 0, t.status,
        );
    }

    snapshot(runId, ts, phase, portfolio, prices = {}) {
        if (!portfolio) return null;
        return this.transaction(() => {
            let gross = 0, net = 0;
            const rows = [];
            for (const p of portfolio.positions || []) {
                const quantity = Number(p.quantity);
                if (!quantity) continue;
                const mark = num(p.markPrice) || num(prices[p.symbol]);
                if (mark > 0) { gross += Math.abs(quantity * mark); net += quantity * mark; }
                rows.push([p.symbol, quantity, mark, num(p.entryPrice), num(p.unrealizedPnl)]);
            }
            const result = this.sql.snapshot.run(runId, ts ?? null, Date.now(), phase, num(portfolio.cash), num(portfolio.available), num(portfolio.equity), gross, net);
            const id = Number(result.lastInsertRowid);
            for (const row of rows) this.sql.position.run(id, ...row);
            return id;
        });
    }

    intent(runId, ts, { symbol, signedQty, price, heldQty, sizingEquity }) {
        const result = this.sql.intent.run(runId, ts, symbol, signedQty, num(price), num(heldQty), num(signedQty * price), num(sizingEquity));
        return Number(result.lastInsertRowid);
    }

    insertOrder(runId, ts, o, status, error = null) {
        const now = Date.now();
        const result = this.sql.order.run(
            runId, ts, o.intentId ?? null, o.symbol, o.side, num(o.quantity), o.reduceOnly ? 1 : 0,
            o.clientOrderId ?? null, num(o.decisionPrice), status, now, now, error,
        );
        return Number(result.lastInsertRowid);
    }

    orderPending(runId, ts, order) {
        return this.insertOrder(runId, ts, order, 'pending');
    }

    orderSkipped(runId, ts, order, reason) {
        return this.insertOrder(runId, ts, order, 'skipped', reason);
    }

    orderResult(orderId, parsed = {}, raw) {
        this.sql.orderResult.run(
            parsed.status ? String(parsed.status).toLowerCase() : 'accepted', Date.now(),
            parsed.exchangeOrderId != null ? String(parsed.exchangeOrderId) : null,
            num(parsed.executedQty), num(parsed.avgPrice), json(raw), orderId,
        );
    }

    orderFailed(orderId, err) {
        const code = err?.code ?? err?.cause?.code;
        const body = err?.body ?? err?.cause?.body;
        this.sql.orderFailed.run('failed', Date.now(), code != null ? String(code) : null, String(err?.message || err), json(body), orderId);
    }

    pendingOrdersAt(runId, timestamp) {
        return this.sql.pendingOrdersAt.all(Number(runId), Number(timestamp));
    }

    answeredOrdersAt(runId, timestamp) {
        return this.sql.answeredOrdersAt.all(Number(runId), Number(timestamp));
    }

    intentsAt(runId, timestamp) {
        return this.sql.intentsAt.all(Number(runId), Number(timestamp));
    }

    record(runId, ts, kind, data = {}) {
        const symbol = typeof data?.symbol === 'string' ? data.symbol : null;
        const value = typeof data?.value === 'number' && Number.isFinite(data.value) ? data.value : null;
        this.sql.record.run(runId, ts, String(kind), symbol, value, json(data));
    }

    command(runId, command, note = '', amount = null) {
        this.sql.insertCommand.run(
            Number(runId), Date.now(), String(command), String(note || '').slice(0, 200), num(amount));
    }

    nextCommand(runId, afterId = 0) {
        return this.sql.nextCommand.get(Number(runId), Number(afterId)) ?? null;
    }

    ackCommands(runId, throughId) {
        this.sql.ackCommands.run(Date.now(), Number(runId), Number(throughId));
    }

    pendingCommand(runId) {
        return this.sql.pendingCommand.get(Number(runId)) ?? null;
    }

    lastIncomeTime(account) {
        const row = this.sql.lastIncome.get(account);
        return row?.time ?? null;
    }

    income(account, runId, rows) {
        if (!rows?.length) return 0;
        return this.transaction(() => {
            let inserted = 0;
            for (const r of rows) {
                const result = this.sql.income.run(
                    account, String(r.id), r.time, r.symbol || null, r.type, Number(r.amount),
                    r.asset ?? null, r.info ?? null, r.tradeId != null ? String(r.tradeId) : null, runId ?? null,
                );
                inserted += Number(result.changes);
            }
            return inserted;
        });
    }

    close() {
        this.db.close();
    }
}
