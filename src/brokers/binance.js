import Broker from './base.js';

/**
 * Binance USD-M futures. Fees are a share of notional.
 *
 * @param {Object}  [opts]
 * @param {number}  [opts.feeBps=5]      Fee in basis points of notional
 * @param {number}  [opts.slippage=0]    Extra fraction of notional per fill, e.g. 0.0005 = 5bps.
 * @param {number}  [opts.impactCoef=1]  Square-root market impact
 */
export default class Binance extends Broker {
    constructor({ feeBps = 5, slippage = 0, impactCoef = 1 } = {}) {
        super();
        this.feeBps = feeBps;
        this.slippage = slippage;
        this.impactCoef = impactCoef;
    }

    calculateFees(quantity, price, side, candle) {
        const notional = quantity * price;
        let fee = notional * (this.feeBps / 1e4 + this.slippage);
        if (this.impactCoef > 0 && candle && candle.quoteVolume > 0) {
            let range = candle.open > 0 ? (candle.high - candle.low) / candle.open : 0.01;
            if (!(range > 0)) range = 0.001;
            if (range > 0.5) range = 0.5;
            fee += notional * this.impactCoef * range * Math.sqrt(notional / candle.quoteVolume);
        }
        return fee;
    }
}
