import Broker from './base.js';

/**
 * Alpaca commission model: commission-free U.S. equity trading with
 * regulatory fees (SEC, FINRA TAF, CAT) plus optional slippage.
 *
 * - Commission:               $0.00 per share
 * - SEC fee (sells only):     $0.00 per $1 000 000
 * - FINRA TAF (sells only):   $0.000166 per share
 * - CAT fee (all executions): $0.0000265 per share
 *
 * @param {number} slippage - slippage as a fraction (e.g. 0.001 = 0.1%)
 */
export default class Alpaca extends Broker {
  constructor(slippage = 0) {
    super();
    this.slippage = slippage;
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
    const secFee = 0;

    // 3) FINRA Trading Activity Fee (sells only)
    const finraTAF = side === 'sell'
      ? quantity * 0.000166
      : 0;

    // 4) Consolidated Audit Trail fee (all executions)
    const catFee = quantity * 0.0000265;

    // 5) Slippage
    const slipCost = notional * this.slippage;

    return commission
         + secFee
         + finraTAF
         + catFee
         + slipCost;
  }
}