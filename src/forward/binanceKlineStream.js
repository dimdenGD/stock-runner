import Candle from '../backtest/candle.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const listen = (socket, event, fn) => {
    if (typeof socket.addEventListener === 'function') socket.addEventListener(event, fn);
    else if (typeof socket.on === 'function') socket.on(event, fn);
    else socket[`on${event}`] = fn;
};

async function messageText(event) {
    const data = event?.data ?? event;
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    if (data && typeof data.text === 'function') return data.text();
    return String(data);
}

export default class BinanceKlineStream {
    constructor({
        symbols,
        interval,
        stepMs,
        url = 'wss://fstream.binance.com/ws',
        graceMs = 5000,
        staleMs = 90000,
        reconnectMinMs = 1000,
        reconnectMaxMs = 30000,
        subscribeBatchSize = 200,
        webSocketImpl = globalThis.WebSocket,
        logger = console,
    }) {
        if (typeof webSocketImpl !== 'function') throw new Error('A WebSocket implementation is required');
        this.interval = interval;
        this.stepMs = stepMs;
        this.url = url;
        this.graceMs = graceMs;
        this.staleMs = staleMs;
        this.reconnectMinMs = reconnectMinMs;
        this.reconnectMaxMs = reconnectMaxMs;
        this.subscribeBatchSize = subscribeBatchSize;
        this.WebSocketImpl = webSocketImpl;
        this.logger = logger;
        this.symbols = new Set();
        this.setSymbols(symbols, { send: false });

        this.socket = null;
        this.open = false;
        this.started = false;
        this.stopped = false;
        this.connectionId = 0;
        this.requestId = 1;
        this.reconnectDelay = reconnectMinMs;
        this.lastMessageAt = 0;
        this.pending = new Map();
        this.finalized = new Set();
        this.queue = [];
        this.waiters = [];
        this.reconnectTimer = null;
        this.watchdog = null;
    }

    streamName(symbol) {
        return `${symbol.toLowerCase()}@kline_${this.interval}`;
    }

    send(method, symbols) {
        if (!this.open || !this.socket || !symbols.length) return;
        for (let i = 0; i < symbols.length; i += this.subscribeBatchSize) {
            const params = symbols.slice(i, i + this.subscribeBatchSize).map(s => this.streamName(s));
            this.socket.send(JSON.stringify({ method, params, id: this.requestId++ }));
        }
    }

    setSymbols(symbols, { send = true } = {}) {
        const next = new Set((symbols || []).map(String));
        if (next.size > 1024) throw new Error(`Binance WebSocket supports at most 1024 streams; got ${next.size}`);
        const added = [...next].filter(s => !this.symbols.has(s));
        const removed = [...this.symbols].filter(s => !next.has(s));
        this.symbols = next;
        if (send) {
            this.send('UNSUBSCRIBE', removed);
            this.send('SUBSCRIBE', added);
        }
        return { added, removed };
    }

    async start() {
        if (this.started) return;
        this.started = true;
        this.stopped = false;
        await this.connect();
        this.watchdog = setInterval(() => {
            if (this.open && this.lastMessageAt && Date.now() - this.lastMessageAt > this.staleMs) {
                this.logger.warn(`Binance WebSocket stale for ${Date.now() - this.lastMessageAt}ms; reconnecting`);
                this.socket?.close(4000, 'stale');
            }
        }, Math.min(30000, Math.max(1000, Math.floor(this.staleMs / 3))));
    }

    async connect() {
        if (this.stopped) return;
        const id = ++this.connectionId;
        const socket = new this.WebSocketImpl(this.url);
        this.socket = socket;
        await new Promise((resolve, reject) => {
            let settled = false;
            listen(socket, 'open', () => {
                if (id !== this.connectionId || this.stopped) return;
                this.open = true;
                this.lastMessageAt = Date.now();
                this.reconnectDelay = this.reconnectMinMs;
                this.send('SUBSCRIBE', [...this.symbols]);
                settled = true;
                resolve();
            });
            listen(socket, 'message', event => {
                if (id !== this.connectionId || this.stopped) return;
                this.lastMessageAt = Date.now();
                this.handleMessage(event).catch(err => this.logger.error(`Binance WebSocket message error: ${err.message}`));
            });
            listen(socket, 'error', event => {
                const err = event?.error || new Error('Binance WebSocket error');
                if (!settled) { settled = true; reject(err); }
                else this.logger.warn(err.message);
            });
            listen(socket, 'close', () => {
                if (id !== this.connectionId) return;
                this.open = false;
                if (!settled) { settled = true; reject(new Error('Binance WebSocket closed before opening')); }
                if (!this.stopped) this.scheduleReconnect();
            });
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer || this.stopped) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectMaxMs, delay * 2);
        this.logger.warn(`Binance WebSocket disconnected; reconnecting in ${delay}ms`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try { await this.connect(); }
            catch (err) {
                this.logger.warn(`Binance WebSocket reconnect failed: ${err.message}`);
                this.scheduleReconnect();
            }
        }, delay);
    }

    async handleMessage(event) {
        const raw = await messageText(event);
        const parsed = JSON.parse(raw);
        const data = parsed.data || parsed;
        if (data.result === null && data.id != null) return;
        if (data.e !== 'kline' || !data.k?.x || data.k.i !== this.interval) return;
        const symbol = String(data.s || data.k.s);
        if (!this.symbols.has(symbol)) return;
        const timestamp = Number(data.k.t) + this.stepMs;
        if (!Number.isFinite(timestamp) || this.finalized.has(timestamp)) return;
        const candle = new Candle(
            Number(data.k.o), Number(data.k.h), Number(data.k.l), Number(data.k.c),
            Number(data.k.v), timestamp, Number(data.k.q),
        );
        let batch = this.pending.get(timestamp);
        if (!batch) {
            batch = {
                timestamp,
                expected: new Set(this.symbols),
                candles: new Map(),
                timer: setTimeout(() => this.flush(timestamp), this.graceMs),
            };
            this.pending.set(timestamp, batch);
        }
        batch.candles.set(symbol, candle);
        if (batch.candles.size >= batch.expected.size) this.flush(timestamp);
    }

    flush(timestamp) {
        const batch = this.pending.get(timestamp);
        if (!batch) return;
        clearTimeout(batch.timer);
        this.pending.delete(timestamp);
        this.finalized.add(timestamp);
        while (this.finalized.size > 100) this.finalized.delete(this.finalized.values().next().value);
        const missing = [...batch.expected].filter(s => !batch.candles.has(s));
        this.push({
            timestamp,
            candles: [...batch.candles].map(([symbol, candle]) => ({ symbol, candle })),
            missing,
            expected: batch.expected.size,
        });
    }

    push(batch) {
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(batch);
        else this.queue.push(batch);
    }

    nextBatch() {
        if (this.queue.length) return Promise.resolve(this.queue.shift());
        if (this.stopped) return Promise.resolve(null);
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    async stop() {
        this.stopped = true;
        this.open = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.watchdog) clearInterval(this.watchdog);
        for (const batch of this.pending.values()) clearTimeout(batch.timer);
        this.pending.clear();
        const socket = this.socket;
        this.socket = null;
        try { socket?.close(1000, 'stopped'); } catch {}
        for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
        await sleep(0);
    }
}
