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
