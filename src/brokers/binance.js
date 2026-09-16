import Broker from './base.js';

/**
 * Binance USD-M futures. Fees are a share of notional.
 *
 * @param {Object}  [opts]
 * @param {number}  [opts.feeBps=5]       Fee in basis points of notional
 * @param {number}  [opts.slippage=0]     Extra fraction of notional per fill, e.g. 0.0005 = 5bps.
 * @param {number}  [opts.impactCoef=1]   Multiplier on the book walk (0 turns impact off)
 * @param {number}  [opts.depthRatio=0.5] Depth within 1% of mid, as a fraction of the bar quote volume
 */
export default class Binance extends Broker {
    constructor({ feeBps = 5, slippage = 0, impactCoef = 1, depthRatio = 0.5 } = {}) {
        super();
        this.feeBps = feeBps;
        this.slippage = slippage;
        this.impactCoef = impactCoef;
        this.depthRatio = depthRatio;
    }

    calculateFees(quantity, price, side, candle) {
        const notional = quantity * price;
        let fee = notional * (this.feeBps / 1e4 + this.slippage);
        if (this.impactCoef > 0 && candle && candle.quoteVolume > 0) {
            const frac = notional / (this.depthRatio * candle.quoteVolume);
            fee += notional * this.impactCoef * Math.min(0.05, (0.01 * frac) / 2);
        }
        return fee;
    }
}
