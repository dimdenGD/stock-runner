import { createHash } from 'node:crypto';
import Broker from './base.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = new Set(['filled', 'canceled', 'expired', 'rejected', 'done_for_day', 'replaced', 'stopped', 'suspended']);

/**
 * Alpaca commission model: commission-free U.S. equity trading with
 * regulatory fees (SEC, FINRA TAF, CAT) plus optional slippage.
 *
 * - Commission:               $0.00 per share
 * - SEC fee (sells only):     $20.60 per $1 000 000
 * - FINRA TAF (sells only):   $0.000195 per share (max $9.79, qty cap 50,205)
 * - CAT fee (all executions): $0.000003 per share
 *
 * @param {object} [options]
 * @param {'paper'|'live'} [options.environment='paper']
 * @param {string} [options.apiKey] - Alpaca API key ID
 * @param {string} [options.apiSecret] - Alpaca API secret key
 * @param {'sip'|'iex'} [options.feed='sip'] - market data feed
 * @param {number} [options.slippage=0] - slippage as a fraction (e.g. 0.001 = 0.1%)
 * @param {number} [options.rpm=190] - data and trading requests per minute
 */
export default class Alpaca extends Broker {
  constructor({
    environment = 'paper',
    apiKey = null,
    apiSecret = null,
    feed = 'sip',
    slippage = 0,
    rpm = 190,
    dataUrl = 'https://data.alpaca.markets',
    paperUrl = 'https://paper-api.alpaca.markets',
    liveUrl = 'https://api.alpaca.markets',
  } = {}) {
    super();
    if (!['paper', 'live'].includes(environment)) throw new TypeError("environment must be 'paper' or 'live'");
    if (!['sip', 'iex'].includes(feed)) throw new TypeError("feed must be 'sip' or 'iex'");
    this.environment = environment;
    this.slippage = Number(slippage) || 0;
    this.apiKey = apiKey || null;
    this.apiSecret = apiSecret || null;
    this.feed = feed;
    this.rpm = Number(rpm) > 0 ? Number(rpm) : 190;
    this.dataUrl = dataUrl.replace(/\/$/, '');
    this.url = (environment === 'paper' ? paperUrl : liveUrl).replace(/\/$/, '');
    this.nextSlot = 0;
  }

  get paper() {
    return this.environment === 'paper';
  }

  get label() {
    return `Alpaca ${this.environment}`;
  }

  get account() {
    const suffix = this.apiKey ? `-${createHash('sha256').update(this.apiKey).digest('hex').slice(0, 10)}` : '';
    return `alpaca-${this.environment}${suffix}`;
  }

  get tradingMode() {
    return this.paper ? 'demo' : 'live';
  }

  static isTerminal(status) {
    return TERMINAL.has(String(status));
  }

  async request(base, path, { method = 'GET', query, body, retries = 5 } = {}) {
    if (!this.apiKey || !this.apiSecret) throw Object.assign(new Error('Alpaca apiKey and apiSecret are required'), { fatal: true });
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const at = Math.max(now, this.nextSlot);
      this.nextSlot = at + 60000 / this.rpm;
      if (at > now) await sleep(at - now);
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: {
            'APCA-API-KEY-ID': this.apiKey,
            'APCA-API-SECRET-KEY': this.apiSecret,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(60000),
        });
      } catch (err) {
        if (attempt >= retries || method !== 'GET') throw err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries && (method === 'GET' || res.status === 429)) {
        await sleep(Number(res.headers.get('retry-after') || 0) * 1000 || 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        let message = text.slice(0, 500);
        try { message = JSON.parse(text).message || message; } catch { }
        throw Object.assign(new Error(`Alpaca HTTP ${res.status}: ${message}`), { status: res.status, code: res.status, body: text });
      }
      return text ? JSON.parse(text) : null;
    }
  }

  trading(path, opts) {
    return this.request(this.url, path, opts);
  }

  data(path, opts) {
    return this.request(this.dataUrl, path, opts);
  }

  getAccount() {
    return this.trading('/v2/account');
  }

  getClock() {
    return this.trading('/v2/clock');
  }

  getCalendar(start, end) {
    return this.trading('/v2/calendar', { query: { start, end } });
  }

  getAssets() {
    return this.trading('/v2/assets', { query: { status: 'active', asset_class: 'us_equity' } });
  }

  getPositions() {
    return this.trading('/v2/positions');
  }

  async getPortfolio() {
    const [account, positions] = await Promise.all([this.getAccount(), this.getPositions()]);
    return {
      equity: Number(account.equity),
      cash: Number(account.cash),
      available: Number(account.buying_power),
      positions: positions.map(p => ({
        symbol: p.symbol,
        quantity: Number(p.qty),
        markPrice: Number(p.current_price),
        entryPrice: Number(p.avg_entry_price),
        unrealizedPnl: Number(p.unrealized_pl),
      })),
    };
  }

  async getTradingStatus() {
    const a = await this.getAccount();
    return { status: a.status, tradingBlocked: a.trading_blocked, accountBlocked: a.account_blocked, patternDayTrader: a.pattern_day_trader, daytradeCount: a.daytrade_count };
  }

  async getOrderByClientId(clientOrderId) {
    try {
      return await this.trading('/v2/orders:by_client_order_id', { query: { client_order_id: clientOrderId } });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  submitOrder({ symbol, qty, side, type = 'market', timeInForce, clientOrderId }) {
    return this.trading('/v2/orders', {
      method: 'POST',
      retries: 0,
      body: { symbol, qty: String(qty), side, type, time_in_force: timeInForce, client_order_id: clientOrderId },
    });
  }

  async bars(symbols, { timeframe, start, end, adjustment = 'raw', batch = 200 } = {}) {
    const out = new Map();
    for (let i = 0; i < symbols.length; i += batch) {
      const chunk = symbols.slice(i, i + batch);
      let pageToken;
      do {
        const res = await this.data('/v2/stocks/bars', {
          query: {
            symbols: chunk.join(','), timeframe, start, end, adjustment,
            feed: this.feed, limit: 10000, sort: 'asc', page_token: pageToken,
          },
        });
        for (const [sym, rows] of Object.entries(res?.bars || {})) {
          const list = out.get(sym) || [];
          for (const b of rows) list.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw, n: b.n });
          out.set(sym, list);
        }
        pageToken = res?.next_page_token || undefined;
      } while (pageToken);
    }
    return out;
  }

  /**
   * Calculates total fees for an Alpaca equity trade.
   * @param {number} quantity – number of shares
   * @param {number} price    – price per share
   * @param {'buy'|'sell'} side
   * @returns {number} total fees in dollars
   */
  calculateFees(quantity, price, side) {
    const notional = quantity * price;

    // 1) Commission-free base
    const commission = 0;

    // 2) SEC fee (sells only)
    const secFee = side === 'sell' ? notional * 0.0000206 : 0;

    // 3) FINRA Trading Activity Fee (sells only)
    //    $0.000195/share, max $9.79/trade
    const finraTAF = side === 'sell'
      ? Math.min(quantity * 0.000195, 9.79)
      : 0;

    // 4) Consolidated Audit Trail fee (all executions)
    const catFee = quantity * 0.000003;

    // 5) Slippage
    const slipCost = notional * this.slippage;

    return commission
         + secFee
         + finraTAF
         + catFee
         + slipCost;
  }
}