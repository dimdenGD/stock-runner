import Broker from './base.js';

/**
 * Alpaca commission model: commission-free U.S. equity trading with
 * regulatory fees (SEC, FINRA TAF, CAT) plus optional slippage.
 *
 * - Commission:               $0.00 per share
 * - SEC fee (sells only):     $20.60 per $1 000 000
 * - FINRA TAF (sells only):   $0.000195 per share (max $9.79, qty cap 50,205)
 * - CAT fee (all executions): $0.000003 per share
 *
 * @param {number} slippage - slippage as a fraction (e.g. 0.001 = 0.1%)
 * @param {boolean} [paper=true] - use paper trading
 * @param {string} [apiKey] - Alpaca API key
 * @param {string} [apiSecret] - Alpaca API secret
 */
export default class Alpaca extends Broker {
  constructor(slippage = 0, paper = true, apiKey, apiSecret) {
    super();
    this.slippage = slippage;
    this.paper = !!paper;
    this.url = this.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
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