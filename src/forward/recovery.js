export async function inspectPendingOrder(broker, row) {
    try {
        const found = await broker.resolvePendingOrder(row);
        if (found?.outcome === 'filled') {
            const parsed = found.parsed || broker.parseOrderResult(found.response);
            if (!(Number(parsed?.avgPrice) > 0) || !(Number(parsed?.executedQty) > 0)) {
                return { id: row.id, symbol: row.symbol, error: 'broker confirmed a fill but returned no usable quantity or price' };
            }
            const normalized = {
                ...parsed,
                status: parsed.status || 'FILLED',
                executedQty: Number(parsed.executedQty),
                avgPrice: Number(parsed.avgPrice),
            };
            return {
                id: row.id,
                symbol: row.symbol,
                outcome: 'filled',
                exchangeOrderId: normalized.exchangeOrderId != null ? String(normalized.exchangeOrderId) : null,
                executedQty: normalized.executedQty,
                avgPrice: normalized.avgPrice,
                response: found.response,
                parsed: normalized,
            };
        }
        if (found?.outcome === 'rejected') {
            return {
                id: row.id,
                symbol: row.symbol,
                outcome: 'rejected',
                reason: found.reason || 'the venue has no record of this order',
                response: found.response ?? null,
            };
        }
        return {
            id: row.id,
            symbol: row.symbol,
            error: found?.reason || 'the venue could not establish what happened to this order',
        };
    } catch (error) {
        return { id: row.id, symbol: row.symbol, error: error?.message || String(error) };
    }
}

export function remainingBatchIntents(rows, balances = {}, prices = {}) {
    const targets = new Map();
    for (const row of rows || []) {
        const symbol = String(row.symbol || '');
        const signedQty = Number(row.signed_qty);
        if (!symbol || !Number.isFinite(signedQty)) continue;
        let target = targets.get(symbol);
        if (!target) {
            target = {
                symbol,
                targetQty: Number(row.held_qty) || 0,
                decisionPrice: Number(row.price) || 0,
            };
            targets.set(symbol, target);
        }
        target.targetQty += signedQty;
        if (Number(row.price) > 0) target.decisionPrice = Number(row.price);
    }

    const intents = [];
    for (const target of targets.values()) {
        const heldQty = Number(balances[target.symbol]) || 0;
        const signedQty = target.targetQty - heldQty;
        const tolerance = 1e-9 * Math.max(1, Math.abs(target.targetQty), Math.abs(heldQty));
        if (Math.abs(signedQty) <= tolerance) continue;
        const price = Number(prices[target.symbol]) > 0
            ? Number(prices[target.symbol])
            : target.decisionPrice;
        if (!(price > 0)) continue;
        intents.push({
            symbol: target.symbol,
            signedQty,
            price,
            heldQty,
            targetQty: target.targetQty,
            journalId: null,
        });
    }
    return intents;
}
