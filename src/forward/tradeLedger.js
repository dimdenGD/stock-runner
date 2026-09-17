export default class TradeLedger {
    constructor(saved = {}) {
        this.positions = {};
        for (const [symbol, p] of Object.entries(saved || {})) {
            if (Number(p?.quantity)) this.positions[symbol] = { ...p, quantity: Number(p.quantity) };
        }
    }

    apply({ symbol, signedQty, price, fee = 0, timestamp }) {
        const quantity = Math.abs(signedQty);
        const pos = this.positions[symbol] ?? { quantity: 0, avgPrice: 0, entryFees: 0, holdSince: null };
        const prev = pos.quantity;
        const closing = prev !== 0 && Math.sign(signedQty) !== Math.sign(prev);
        const closedQty = closing ? Math.min(quantity, Math.abs(prev)) : 0;
        let closed = null;

        if (closedQty > 0) {
            const dir = Math.sign(prev);
            const entryFee = pos.entryFees * (closedQty / Math.abs(prev));
            const exitFee = fee * (closedQty / quantity);
            const profit = dir * closedQty * (price - pos.avgPrice) - entryFee - exitFee;
            closed = {
                symbol, dir, quantity: closedQty, price, entryPrice: pos.avgPrice, fee: exitFee, profit,
                profitPercent: pos.avgPrice > 0 ? profit / (closedQty * pos.avgPrice) : 0,
                holdMs: pos.holdSince == null ? null : +timestamp - pos.holdSince,
            };
            pos.entryFees -= entryFee;
        }

        let next = prev + signedQty;
        if (Math.abs(next) <= 1e-9 * Math.max(1, Math.abs(prev))) next = 0;
        const opened = quantity - closedQty;
        if (opened > 0 && next !== 0) {
            const base = closing ? 0 : Math.abs(prev);
            pos.avgPrice = (base * (closing ? 0 : pos.avgPrice) + opened * price) / (base + opened);
            pos.entryFees = (closing ? 0 : pos.entryFees) + fee * (opened / quantity);
            if (base === 0) pos.holdSince = +timestamp;
        }

        if (next === 0) delete this.positions[symbol];
        else this.positions[symbol] = { ...pos, quantity: next };
        return closed;
    }

    reconcile(positions = [], feeFor = () => 0) {
        const live = new Map();
        for (const p of positions) if (Number(p.quantity)) live.set(p.symbol, p);
        for (const symbol of Object.keys(this.positions)) if (!live.has(symbol)) delete this.positions[symbol];
        for (const [symbol, p] of live) {
            const quantity = Number(p.quantity);
            const known = this.positions[symbol];
            if (known && Math.abs(known.quantity - quantity) <= 1e-9 * Math.max(1, Math.abs(quantity))) continue;
            const avgPrice = Number(p.entryPrice) > 0 ? Number(p.entryPrice) : Number(p.markPrice) || 0;
            const sameSide = known && Math.sign(known.quantity) === Math.sign(quantity);
            this.positions[symbol] = {
                quantity,
                avgPrice,
                entryFees: feeFor(symbol, Math.abs(quantity), avgPrice),
                holdSince: sameSide ? known.holdSince : null,
            };
        }
    }

    toJSON() {
        return this.positions;
    }
}
