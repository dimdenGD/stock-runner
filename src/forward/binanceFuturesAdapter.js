import Candle from '../backtest/candle.js';
import BinanceKlineStream from './binanceKlineStream.js';

export function rowToClosedCandle(row, stepMs) {
    return new Candle(
        Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]),
        Number(row[5]), Number(row[0]) + stepMs, Number(row[7]),
    );
}

export default class BinanceFuturesAdapter {
    constructor(client, {
        webSocketUrl,
        webSocketImpl = globalThis.WebSocket,
        streamFactory = opts => new BinanceKlineStream(opts),
    } = {}) {
        if (!client) throw new TypeError('BinanceFuturesAdapter requires a client');
        this.client = client;
        this.webSocketUrl = webSocketUrl;
        this.webSocketImpl = webSocketImpl;
        this.streamFactory = streamFactory;
        this.label = `Binance Futures ${client.environment || ''}`.trim();
    }

    now() {
        return Date.now() + Number(this.client.timeOffsetMs || 0);
    }

    async initialize() {
        await this.client.syncTime();
        const mode = await this.client.getPositionMode();
        if (mode.dualSidePosition === true) {
            throw new Error('Binance Futures forward trading requires one-way position mode');
        }
    }

    async getTradableSymbols() {
        await this.client.loadExchangeInfo();
        return this.client.getTradableSymbols();
    }

    async getPortfolio() {
        const [account, positions] = await Promise.all([
            this.client.getAccount(),
            this.client.getPositions(),
        ]);
        return {
            cash: Number(account.availableBalance ?? account.totalWalletBalance ?? 0),
            available: Number(account.availableBalance ?? 0),
            equity: Number(account.totalMarginBalance ?? account.totalWalletBalance ?? 0),
            positions: (positions || []).map(position => ({
                symbol: position.symbol,
                quantity: Number(position.positionAmt),
                markPrice: Number(position.markPrice),
            })),
        };
    }

    async getHistory(symbol, interval, bars, { endTime = this.now(), stepMs } = {}) {
        const rows = await this.client.getKlineHistory(symbol, interval, bars, { endTime });
        return rows.map(row => rowToClosedCandle(row, stepMs));
    }

    async getClosedCandle(symbol, interval, timestamp, { stepMs } = {}) {
        const rows = await this.client.getKlines(symbol, interval, { endTime: timestamp, limit: 2 });
        const row = rows.find(candidate => Number(candidate[0]) + stepMs === timestamp
            && Number(candidate[6]) < this.now());
        return row ? rowToClosedCandle(row, stepMs) : null;
    }

    createStream({ symbols, interval, stepMs, graceMs, logger }) {
        return this.streamFactory({
            symbols,
            interval,
            stepMs,
            graceMs,
            url: this.webSocketUrl,
            webSocketImpl: this.webSocketImpl,
            logger,
        });
    }

    normalizeQuantity(symbol, signedQuantity, price, options) {
        return this.client.quantityFor(symbol, signedQuantity, price, options);
    }

    createClientOrderId({ timestamp, symbol, sequence }) {
        return `fw-${timestamp.toString(36)}-${symbol.slice(0, 12)}-${sequence}`.slice(0, 36);
    }

    placeMarketOrder(order) {
        if (!['buy', 'sell'].includes(order.side)) throw new TypeError('side must be buy or sell');
        return this.client.placeMarketOrder({
            ...order,
            side: order.side === 'buy' ? 'BUY' : 'SELL',
        });
    }
}
