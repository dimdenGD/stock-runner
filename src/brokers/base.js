export const FORWARD_METHODS = [
    'initialize', 'getTradableSymbols', 'getPortfolio', 'getHistory',
    'getClosedCandle', 'createStream', 'normalizeQuantity', 'placeMarketOrder',
];

export default class Broker {
    market = 'stocks';

    get label() {
        return this.constructor.name;
    }

    get account() {
        return this.label;
    }

    calculateFees(quantity, price, side, candle) {
        return 0;
    }

    missingForwardMethods() {
        return FORWARD_METHODS.filter(method => typeof this[method] !== 'function');
    }

    now() {
        return Date.now();
    }

    createClientOrderId({ timestamp, symbol, sequence }) {
        const tag = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'sym';
        return `fw-${timestamp.toString(36)}-${tag}-${sequence}`.slice(0, 36);
    }

    parseOrderResult(result) {
        return {};
    }

    async getIncome() {
        return null;
    }
}
