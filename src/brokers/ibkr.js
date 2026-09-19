import Broker from './base.js';

const SEC_SELL_RATE = 20.60 / 1_000_000;
const TAF_SELL_PER_SHARE = 0.000195;
const TAF_SELL_MAX_USD = 9.79;
const CAT_PER_SHARE = 0.000003;
const CLEARING_PER_SHARE = 0.00020;
const DEFAULT_TAKE_PER_SHARE = 0.0030;
const COMMISSION_PASS_THROUGH_RATE = 0.000175 + 0.00056;
const FRACTIONAL_FEE_RATE = 0.01;
const FRACTIONAL_MIN_ORDER_USD = 0.01;

function standardCommission(quantity, price, feeType) {
    if (!(quantity > 0)) return 0;
    const perShare = feeType === 'fixed' ? 0.0050 : 0.0035;
    const minimum = feeType === 'fixed' ? 1.00 : 0.35;
    const notional = quantity * price;
    return Math.min(Math.max(quantity * perShare, minimum), notional * 0.01);
}

export function ibkrCommission(quantity, price, feeType = 'tiered') {
    if (!(quantity > 0) || !(price > 0)) return 0;
    const nearest = Math.round(quantity);
    const tolerance = 1e-9;
    if (Math.abs(quantity - nearest) <= tolerance) {
        return standardCommission(nearest, price, feeType);
    }

    return Math.max(FRACTIONAL_MIN_ORDER_USD, quantity * price * FRACTIONAL_FEE_RATE);
}

export function calculateIbkrFees({
    quantity, price, side, feeType = 'tiered', exchangeFeePerShare = DEFAULT_TAKE_PER_SHARE,
}) {
    if (!(quantity > 0) || !(price > 0)) return 0;
    const notional = quantity * price;
    const commission = ibkrCommission(quantity, price, feeType);
    const secFee = side === 'sell' ? notional * SEC_SELL_RATE : 0;
    const finraTAF = side === 'sell'
        ? Math.min(quantity * TAF_SELL_PER_SHARE, TAF_SELL_MAX_USD)
        : 0;
    const finraCAT = quantity * CAT_PER_SHARE;

    let tieredFees = 0;
    if (feeType === 'tiered') {
        tieredFees = quantity * (CLEARING_PER_SHARE + exchangeFeePerShare)
            + commission * COMMISSION_PASS_THROUGH_RATE;
    }
    return commission + secFee + finraTAF + finraCAT + tieredFees;
}

/**
 * Interactive Brokers commission model: supports both Fixed and Tiered pricing.
 *
 * Fixed:  $0.0050 per share, min $1.00 per order, max 1% of notional.
 * Tiered: $0.0035 per share, min $0.35 per order, max 1% of notional.
 */
export default class IBKR extends Broker {
    /**
     * @param {'fixed'|'tiered'} feeType
     * @param {number} slippage - slippage in percentage
     */
    constructor(feeType = 'tiered', slippage = 0, { exchangeFeePerShare = DEFAULT_TAKE_PER_SHARE } = {}) {
        super();
        if (!['fixed', 'tiered'].includes(feeType)) {
            throw new TypeError('feeType must be "fixed" or "tiered"');
        }
        this.feeType = feeType;
        this.slippage = slippage;
        this.exchangeFeePerShare = exchangeFeePerShare;
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
        return calculateIbkrFees({
            quantity, price, side, feeType: this.feeType,
            exchangeFeePerShare: this.exchangeFeePerShare,
        }) + notional * this.slippage;
    }
}
