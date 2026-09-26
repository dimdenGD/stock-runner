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

const sameCandle = (a, b) => a.open === b.open && a.high === b.high && a.low === b.low
    && a.close === b.close && a.volume === b.volume;

export function hyperliquidCandle(c, stepMs) {
    const o = Number(c.o), h = Number(c.h), l = Number(c.l), cl = Number(c.c), v = Number(c.v);
    return new Candle(o, h, l, cl, v, Number(c.t) + stepMs, v * (o + h + l + cl) / 4);
}

export default class HyperliquidCandleStream {
    constructor({
        symbols,
        interval,
        stepMs,
        url = 'wss://api.hyperliquid.xyz/ws',
        graceMs = 5000,
        settleMs = null,
        staleMs = 90000,
        pingMs = 30000,
        reconnectMinMs = 1000,
        reconnectMaxMs = 30000,
        maxSubscriptions = 1000,
        webSocketImpl = globalThis.WebSocket,
        logger = console,
    }) {
        if (typeof webSocketImpl !== 'function') throw new Error('A WebSocket implementation is required');
        this.interval = interval;
        this.stepMs = stepMs;
        this.url = url;
        this.graceMs = graceMs;
        this.settleMs = settleMs == null ? null : Math.max(0, Number(settleMs));
        this.onCorrection = null;
        this.provisional = new Map();
        this.provisionalCandles = 0;
        this.corrections = 0;
        this.staleMs = staleMs;
        this.pingMs = pingMs;
        this.reconnectMinMs = reconnectMinMs;
        this.reconnectMaxMs = reconnectMaxMs;
        this.maxSubscriptions = maxSubscriptions;
        this.WebSocketImpl = webSocketImpl;
        this.logger = logger;
        this.symbols = new Set();
        this.setSymbols(symbols, { send: false });

        this.socket = null;
        this.open = false;
        this.started = false;
        this.stopped = false;
        this.connectionId = 0;
        this.reconnectDelay = reconnectMinMs;
        this.lastMessageAt = 0;
        this.lastDataAt = 0;
        this.connectedAt = 0;
        this.dataMessages = 0;
        this.closedKlines = 0;
        this.healthWaiters = [];
        this.latest = new Map();
        this.closed = new Map();
        this.finalized = new Set();
        this.queue = [];
        this.waiters = [];
        this.reconnectTimer = null;
        this.boundaryTimer = null;
        this.watchdog = null;
        this.pinger = null;
    }

    send(method, symbols) {
        if (!this.open || !this.socket) return;
        for (const coin of symbols) {
            this.socket.send(JSON.stringify({ method, subscription: { type: 'candle', coin, interval: this.interval } }));
        }
    }

    setSymbols(symbols, { send = true } = {}) {
        const next = new Set((symbols || []).map(String));
        if (next.size > this.maxSubscriptions) throw new Error(`Hyperliquid WebSocket allows at most ${this.maxSubscriptions} subscriptions; got ${next.size}`);
        const added = [...next].filter(s => !this.symbols.has(s));
        const removed = [...this.symbols].filter(s => !next.has(s));
        this.symbols = next;
        if (send) {
            this.send('unsubscribe', removed);
            this.send('subscribe', added);
        }
        return { added, removed };
    }

    async start() {
        if (this.started) return;
        this.started = true;
        this.stopped = false;
        await this.connect();
        this.scheduleBoundary();
        this.pinger = setInterval(() => {
            if (this.open) {
                try { this.socket.send(JSON.stringify({ method: 'ping' })); } catch {}
            }
        }, this.pingMs);
        this.watchdog = setInterval(() => {
            const last = this.lastMessageAt || this.connectedAt;
            if (this.open && last && Date.now() - last > this.staleMs) {
                this.logger.warn(`Hyperliquid WebSocket silent for ${Date.now() - last}ms; reconnecting`);
                this.socket?.close(4000, 'stale');
            }
        }, Math.min(30000, Math.max(1000, Math.floor(this.staleMs / 3))));
    }

    scheduleBoundary() {
        if (this.stopped) return;
        const now = Date.now();
        const wait = this.settleMs ?? this.graceMs;
        const boundary = Math.ceil((now - wait + 1) / this.stepMs) * this.stepMs;
        this.boundaryTimer = setTimeout(() => {
            this.flush(boundary);
            this.scheduleBoundary();
        }, Math.max(0, boundary + wait - now));
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
                this.connectedAt = Date.now();
                this.lastMessageAt = this.connectedAt;
                this.lastDataAt = 0;
                this.reconnectDelay = this.reconnectMinMs;
                this.logger.log(`Hyperliquid WebSocket connected; subscribing to ${this.symbols.size} ${this.interval} candle streams`);
                this.send('subscribe', [...this.symbols]);
                settled = true;
                resolve();
            });
            listen(socket, 'message', event => {
                if (id !== this.connectionId || this.stopped) return;
                this.lastMessageAt = Date.now();
                this.handleMessage(event).catch(err => this.logger.error(`Hyperliquid WebSocket message error: ${err.message}`));
            });
            listen(socket, 'error', event => {
                const err = event?.error || new Error('Hyperliquid WebSocket error');
                if (!settled) { settled = true; reject(err); }
                else this.logger.warn(err.message);
            });
            listen(socket, 'close', () => {
                if (id !== this.connectionId) return;
                this.open = false;
                if (!settled) { settled = true; reject(new Error('Hyperliquid WebSocket closed before opening')); }
                if (!this.stopped) this.scheduleReconnect();
            });
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer || this.stopped) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectMaxMs, delay * 2);
        this.logger.warn(`Hyperliquid WebSocket disconnected; reconnecting in ${delay}ms`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try { await this.connect(); }
            catch (err) {
                this.logger.warn(`Hyperliquid WebSocket reconnect failed: ${err.message}`);
                this.scheduleReconnect();
            }
        }, delay);
    }

    async handleMessage(event) {
        const msg = JSON.parse(await messageText(event));
        if (msg.channel === 'subscriptionResponse' || msg.channel === 'pong') return;
        if (msg.channel === 'error') {
            this.logger.error(`Hyperliquid WebSocket error: ${JSON.stringify(msg.data)}`);
            return;
        }
        if (msg.channel !== 'candle') return;
        for (const c of Array.isArray(msg.data) ? msg.data : [msg.data]) this.onCandle(c);
    }

    onCandle(c) {
        if (!c || c.i !== this.interval) return;
        const symbol = String(c.s);
        if (!this.symbols.has(symbol)) return;
        const t = Number(c.t);
        if (!Number.isFinite(t)) return;
        const firstOnConnection = !this.lastDataAt;
        this.lastDataAt = Date.now();
        this.dataMessages++;
        if (firstOnConnection) {
            this.logger.log(`Hyperliquid WebSocket market data live: ${symbol} ${this.interval}`);
            for (const waiter of this.healthWaiters.splice(0)) waiter.resolve(this.getHealth());
        }
        const prev = this.latest.get(symbol);
        if (prev && prev.t < t) this.closed.set(`${symbol}|${prev.t}`, prev.c);
        if (!prev || prev.t <= t) this.latest.set(symbol, { t, c });
        if (t + this.stepMs <= Date.now() - this.graceMs) this.closed.set(`${symbol}|${t}`, c);
        if (this.finalized.has(t + this.stepMs)) this.settleProvisional(symbol, t + this.stepMs, hyperliquidCandle(c, this.stepMs));
    }

    settleProvisional(symbol, timestamp, candle) {
        const key = `${symbol}|${timestamp}`;
        const provisional = this.provisional.get(key);
        if (!provisional || sameCandle(provisional, candle)) return;
        this.provisional.set(key, candle);
        this.corrections++;
        try {
            this.onCorrection?.({ timestamp, symbol, candle, provisional });
        } catch (err) {
            this.logger.error(`Hyperliquid WebSocket correction handler failed: ${err.message}`);
        }
    }

    flush(timestamp) {
        if (this.finalized.has(timestamp)) return;
        this.finalized.add(timestamp);
        while (this.finalized.size > 100) this.finalized.delete(this.finalized.values().next().value);
        const barStart = timestamp - this.stepMs;
        const candles = [], missing = [], provisional = [];
        for (const symbol of this.symbols) {
            const key = `${symbol}|${barStart}`;
            const latest = this.latest.get(symbol);
            const confirmed = this.closed.get(key);
            const c = confirmed ?? (latest && latest.t === barStart ? latest.c : null);
            if (c) {
                const candle = hyperliquidCandle(c, this.stepMs);
                candles.push({ symbol, candle });
                this.closedKlines++;
                if (!confirmed && this.settleMs != null) {
                    this.provisional.set(`${symbol}|${timestamp}`, candle);
                    provisional.push(symbol);
                }
            } else {
                missing.push(symbol);
            }
        }
        this.provisionalCandles += provisional.length;
        for (const key of this.provisional.keys()) {
            if (Number(key.slice(key.lastIndexOf('|') + 1)) < timestamp - 4 * this.stepMs) this.provisional.delete(key);
        }
        for (const key of this.closed.keys()) {
            if (Number(key.slice(key.lastIndexOf('|') + 1)) <= barStart) this.closed.delete(key);
        }
        if (!this.lastDataAt && !candles.length) return;
        this.push({ timestamp, candles, missing, provisional, expected: this.symbols.size });
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

    getHealth() {
        return {
            connected: this.open,
            symbols: this.symbols.size,
            lastMessageAt: this.lastMessageAt,
            lastDataAt: this.lastDataAt,
            dataMessages: this.dataMessages,
            closedKlines: this.closedKlines,
            provisionalCandles: this.provisionalCandles,
            corrections: this.corrections,
        };
    }

    waitForData(timeoutMs = 15000) {
        if (this.lastDataAt) return Promise.resolve(this.getHealth());
        if (this.stopped) return Promise.reject(new Error('Hyperliquid WebSocket is stopped'));
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            };
            const timer = setTimeout(() => {
                const at = this.healthWaiters.indexOf(waiter);
                if (at >= 0) this.healthWaiters.splice(at, 1);
                reject(new Error(`Hyperliquid WebSocket opened but received no market data within ${timeoutMs}ms`));
            }, timeoutMs);
            this.healthWaiters.push(waiter);
        });
    }

    async stop() {
        this.stopped = true;
        this.open = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.boundaryTimer) clearTimeout(this.boundaryTimer);
        if (this.watchdog) clearInterval(this.watchdog);
        if (this.pinger) clearInterval(this.pinger);
        const socket = this.socket;
        this.socket = null;
        try { socket?.close(1000, 'stopped'); } catch {}
        for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
        for (const waiter of this.healthWaiters.splice(0)) waiter.reject(new Error('Hyperliquid WebSocket stopped before receiving market data'));
        await sleep(0);
    }
}
