import Broker from './base.js';

/**
 * Interactive Brokers commission model: supports both Fixed and Tiered pricing.
 *
 * Fixed:  $0.0050 per share, min $1.00 per order, max 1% of notional.
 * Tiered: $0.0035 per share, min $0.35 per order, max 1% of notional.
 */
export default class IBKR extends Broker {
    /**
     * @param {'fixed'|'tiered'} feeType
     */
    constructor(feeType = 'tiered') {
        super();
        if (!['fixed', 'tiered'].includes(feeType)) {
            throw new TypeError('feeType must be "fixed" or "tiered"');
        }
        this.feeType = feeType;
    }

    /**
     * Calculates commission fees per IBKR model.
     * @param {number} quantity – number of shares
     * @param {number} price    – price per share
     * @param {'buy'|'sell'} side
     * @returns {number} fee in dollars
     */
    calculateFees(quantity, price, side) {
        const notional = quantity * price;
        // 1) IBKR Base Commission
        let perShare, minFee;
        if (this.feeType === 'fixed') {
            perShare = 0.0050;
            minFee   = 1.00;
        } else {
            perShare = 0.0035;
            minFee   = 0.35;
        }
        // base commission
        let commission = quantity * perShare;
        if (commission < minFee) commission = minFee;
        const maxCommission = notional * 0.01;
        if (commission > maxCommission) commission = maxCommission;

        // 2) Regulatory Fees (applies to both Fixed & Tiered)
        const finraTAF = side === 'sell' ? quantity * 0.000166 : 0;
        const finraCAT = side === 'sell' ? quantity * 0.000022 : 0;

        let clearing = 0;
        let passThruNYSE = 0;
        let passThruFINRA = 0;

        if (this.feeType === 'tiered') {
            // 3) Clearing Fees (NSCC/DTC): $0.00020 per share
            clearing = quantity * 0.00020;
            // 4) Pass-Through Fees (as percentage of commission)
            passThruNYSE = commission * 0.000175;
            passThruFINRA = commission * 0.00056;
        }

        // total all fees
        const total = commission + finraTAF + finraCAT + clearing + passThruNYSE + passThruFINRA;
        return total;
    }
}
