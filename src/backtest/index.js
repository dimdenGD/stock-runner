/**
 * Backtest orchestrator: holds balances, executes trades, and runs a Strategy.
 */
export default class Backtest {
    /**
     * @param {Object} params
     * @param {Object} params.strategy            – Strategy instance
     * @param {string} params.stockName           – Ticker symbol
     * @param {Date}   params.startDate           – Backtest start
     * @param {Date}   params.endDate             – Backtest end
     * @param {number} params.startDollarBalance  – Starting cash balance
     */
    constructor({ strategy, stockName, startDate, endDate, startDollarBalance }) {
      this.strategy           = strategy;
      this.stockName          = stockName;
      this.startDate          = startDate;
      this.endDate            = endDate;
      this.startDollarBalance = startDollarBalance;
  
      this.dollarBalance      = startDollarBalance;
      this.stockBalance       = 0;
      this.swaps             = [];
      this.trades            = [];
    }
  
    /**
     * Kick off the strategy, passing `this` so onTick can call buy/sell
     */
    async run() {
      await this.strategy.runBacktest(this);
    }
  
    /**
     * Place a market buy order: deduct cash, increase shares.
     * @param {number} quantity    – Number of shares to buy
     * @param {number} price       – Execution price per share
     * @param {number|Date} [timestamp=Date.now()]
     */
    buy(quantity, price, timestamp = Date.now()) {
      const cost = quantity * price;
      if (cost > this.dollarBalance) {
        throw new Error(
          `Insufficient cash: need ${cost.toFixed(2)}, have ${this.dollarBalance.toFixed(2)}`
        );
      }
      this.dollarBalance -= cost;
      this.stockBalance  += quantity;
      this.swaps.push({
        type: 'buy',
        quantity,
        price,
        timestamp: timestamp instanceof Date ? timestamp.getTime() : timestamp
      });
      console.log(`[${new Date(timestamp).toISOString()}] Bought ${+quantity.toFixed(2)} shares at ${+price.toFixed(2)} for ${+cost.toFixed(2)}. Balance: ${+this.dollarBalance.toFixed(2)}`);
    }
  
    /**
     * Place a market sell order: deduct shares, increase cash.
     * @param {number} quantity    – Number of shares to sell
     * @param {number} price       – Execution price per share
     * @param {number|Date} [timestamp=Date.now()]
     */
    sell(quantity, price, timestamp = Date.now()) {
      if (quantity > this.stockBalance) {
        throw new Error(
          `Insufficient shares: trying to sell ${quantity}, have ${this.stockBalance}`
        );
      }
      const proceeds = quantity * price;
      this.dollarBalance += proceeds;
      this.stockBalance  -= quantity;
      this.swaps.push({
        type: 'sell',
        quantity,
        price,
        timestamp: timestamp instanceof Date ? timestamp.getTime() : timestamp
      });
      console.log(`[${new Date(timestamp).toISOString()}] Sold ${+quantity.toFixed(2)} shares at ${+price.toFixed(2)} for ${+proceeds.toFixed(2)}. Balance: ${+this.dollarBalance.toFixed(2)}`);
    }
  
    /**
     * Current value of held shares at given price
     * @param {number} price – Price per share
     * @returns {number}
     */
    positionValue(price) {
      return this.stockBalance * price;
    }
  
    /**
     * Total account value: cash + market value of shares
     * @param {number} price – Price per share
     * @returns {number}
     */
    totalValue(price) {
      return this.dollarBalance + this.positionValue(price);
    }
  }
  