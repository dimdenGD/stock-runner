import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(x => {
    const [key, value = 'true'] = x.slice(2).split('=');
    return [key, value];
}));
const dataDir = args.dir || 'output/forward';
const strategies = existsSync(dataDir)
    ? readdirSync(dataDir, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(dataDir, d.name, 'journal.sqlite'))).map(d => d.name)
    : [];
const strategyName = args.strategy || (strategies.length === 1 ? strategies[0] : null);
if (!args.db && !strategyName) {
    console.log(strategies.length ? `Choose --strategy=<name>: ${strategies.join(', ')}` : `No forward journals under ${dataDir}`);
    process.exit(1);
}
const db = new DatabaseSync(args.db || join(dataDir, strategyName, 'journal.sqlite'), { readOnly: true });
const iso = (ms) => (ms == null ? '-' : new Date(ms).toISOString().replace('.000Z', 'Z'));
const usd = (x) => (x == null ? '-' : `$${Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

if (args.runs) {
    for (const r of db.prepare('SELECT id, strategy, account, dry_run, started_at, ended_at, end_reason FROM runs ORDER BY id DESC LIMIT 50').all()) {
        console.log(`#${r.id} ${r.strategy} ${r.account}${r.dry_run ? ' dry-run' : ''} ${iso(r.started_at)} -> ${iso(r.ended_at)} ${r.end_reason || 'running'}`);
    }
    process.exit(0);
}

const run = args.run
    ? db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(args.run))
    : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get();
if (!run) {
    console.log('No matching run');
    process.exit(1);
}
const id = run.id;
const until = run.ended_at || Date.now();

console.log(`Run #${id} ${run.strategy} on ${run.account}${run.dry_run ? ' (dry-run)' : ''}, capital ${usd(run.capital)}`);
console.log(`  ${iso(run.started_at)} -> ${run.ended_at ? iso(run.ended_at) : 'running'}  end=${run.end_reason || '-'}  commit=${(run.git_commit || '-').slice(0, 10)}${run.git_dirty ? '+dirty' : ''}`);
if (run.error) console.log(`  error: ${run.error.split('\n')[0]}`);

const ticks = db.prepare(`SELECT COUNT(*) n, SUM(intents > 0) active, SUM(missing) missing, SUM(recovered) recovered,
    MIN(ts) first, MAX(ts) last, AVG(duration_ms) ms FROM ticks WHERE run_id = ?`).get(id);
const statuses = db.prepare('SELECT status, COUNT(*) n FROM ticks WHERE run_id = ? GROUP BY status').all(id);
console.log(`\nTicks: ${ticks.n} (${ticks.active || 0} with intents) ${iso(ticks.first)} -> ${iso(ticks.last)}  avg ${Math.round(ticks.ms || 0)}ms`);
console.log(`  status ${statuses.map(s => `${s.status}=${s.n}`).join(' ') || '-'}  recovered candles ${ticks.recovered || 0}  missing ${ticks.missing || 0}`);

const snaps = db.prepare(`SELECT phase, ts, equity, available, gross, net, (SELECT COUNT(*) FROM positions p WHERE p.snapshot_id = s.id) positions
    FROM snapshots s WHERE run_id = ? ORDER BY id`).all(id);
if (snaps.length) {
    const first = snaps[0], last = snaps.at(-1);
    console.log(`\nAccount: equity ${usd(first.equity)} -> ${usd(last.equity)} (${(((last.equity / first.equity) - 1) * 100).toFixed(2)}%)`);
    console.log(`  latest ${last.phase} ${iso(last.ts)}: gross ${usd(last.gross)} (${(last.gross / last.equity).toFixed(2)}x)  net ${usd(last.net)} (${(last.net / last.equity).toFixed(2)}x)  positions ${last.positions}  available ${usd(last.available)}`);
}

const orders = db.prepare('SELECT status, COUNT(*) n, SUM(filled_notional) notional FROM v_orders WHERE run_id = ? GROUP BY status').all(id);
console.log(`\nOrders: ${orders.map(o => `${o.status}=${o.n}`).join(' ') || '-'}  filled notional ${usd(orders.reduce((a, o) => a + (o.notional || 0), 0))}`);
const slips = db.prepare('SELECT slippage_bps s, filled_notional n FROM v_orders WHERE run_id = ? AND slippage_bps IS NOT NULL ORDER BY slippage_bps').all(id);
if (slips.length) {
    const weighted = slips.reduce((a, x) => a + x.s * x.n, 0) / slips.reduce((a, x) => a + x.n, 0);
    const pct = (p) => slips[Math.min(slips.length - 1, Math.floor(p * slips.length))].s.toFixed(1);
    console.log(`  slippage vs decision price (+ = worse): notional-weighted ${weighted.toFixed(1)}bp  median ${pct(0.5)}bp  p10 ${pct(0.1)}bp  p90 ${pct(0.9)}bp  n=${slips.length}`);
}
const problems = db.prepare(`SELECT bar_time, symbol, side, quantity, status, error_code, error FROM v_orders
    WHERE run_id = ? AND status IN ('failed', 'skipped', 'pending') ORDER BY id DESC LIMIT 15`).all(id);
for (const p of problems) console.log(`  ${p.bar_time} ${p.status} ${p.symbol} ${p.side} ${p.quantity}${p.error_code ? ` [${p.error_code}]` : ''} ${p.error || ''}`);

const income = db.prepare(`SELECT type, asset, SUM(amount) amount, COUNT(*) n FROM income
    WHERE account = ? AND time >= ? AND time <= ? GROUP BY type, asset ORDER BY type`).all(run.account, run.started_at, until);
if (income.length) {
    console.log('\nIncome during run:');
    for (const r of income) console.log(`  ${r.type.padEnd(22)} ${r.amount.toFixed(4).padStart(14)} ${r.asset || ''}  (${r.n})`);
}

const records = db.prepare('SELECT kind, COUNT(*) n, COUNT(DISTINCT ts) bars FROM records WHERE run_id = ? GROUP BY kind').all(id);
if (records.length) console.log(`\nStrategy records: ${records.map(r => `${r.kind}=${r.n} over ${r.bars} bars`).join('  ')}`);

const events = db.prepare(`SELECT at, level, type, message FROM events WHERE run_id = ? AND level IN ('warn', 'error') ORDER BY id DESC LIMIT 10`).all(id);
if (events.length) {
    console.log('\nWarnings/errors (latest first):');
    for (const e of events) console.log(`  ${iso(e.at)} ${e.level} ${e.type}: ${e.message}`);
}
