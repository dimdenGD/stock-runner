export const FORWARD_METHODS = [
    'initialize', 'getTradableSymbols', 'getPortfolio', 'getHistory',
    'getClosedCandle', 'createStream', 'normalizeQuantity', 'placeMarketOrder',
];

export default class Broker {
    market = 'stocks';
    orderConcurrency = 1;

    get label() {
        return this.constructor.name;
    }

    get account() {
        return this.label;
    }

    get dataSource() {
        return this.label;
    }

    calculateFees(quantity, price, side, candle) {
        return 0;
    }

    get tradingMode() {
        return 'live';
    }

    executionPrice(quantity, price, side, candle) {
        return price;
    }

    async prepareBacktest() {
    }

    quantize(symbol, signedQty, price, { reduceOnly = false } = {}) {
        return signedQty;
    }

    splitMaxQty(symbol, signedQty) {
        return [signedQty];
    }

    missingForwardMethods() {
        return FORWARD_METHODS.filter(method => typeof this[method] !== 'function');
    }

    now() {
        return Date.now();
    }

    createClientOrderId({ timestamp, symbol, sequence, owner = 'fw' }) {
        const tag = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'sym';
        return `${owner}-${timestamp.toString(36)}-${tag}-${sequence}`.slice(0, 36);
    }

    parseOrderResult(result) {
        return {};
    }

    /**
     * Turn the venue's immediate placement response into a terminal result.
     * Some venues acknowledge a market order while it is still NEW or
     * PARTIALLY_FILLED. Implementations must either return a result that will
     * no longer change or throw.
     */
    async finalizeOrderResult(result) {
        const status = String(result?.status || '').toUpperCase();
        if (['NEW', 'PENDING', 'PENDING_NEW', 'PARTIALLY_FILLED'].includes(status)) {
            const error = new Error(`${this.label} returned a non-terminal ${status} order result`);
            error.code = 'ORDER_NOT_FINAL';
            throw error;
        }
        return result;
    }

    /**
     * Look up an order by the stable venue key created before submission.
     * Live brokers should return { outcome: 'filled', response, parsed },
     * { outcome: 'rejected', reason, response }, or { outcome: 'unknown', reason }.
     */
    async resolvePendingOrder() {
        return {
            outcome: 'unknown',
            reason: `${this.label} does not support interrupted-order reconciliation`,
        };
    }

    /**
     * Classify a failed placement without embedding venue rules in the runner.
     * - `retry` means the venue definitely rejected the attempt and that the same client order id may be reused.
     * - `ambiguous` means it may have traded, so the runner must reconcile.
     * - `reject` is terminal.
     */
    orderFailureDisposition() {
        return { action: 'ambiguous' };
    }

    async getIncome() {
        return null;
    }

    async excludedSymbols() {
        return new Set();
    }
}
