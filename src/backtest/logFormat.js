import chalk from 'chalk';
import ms from 'ms';
import { formatDate } from '../utils.js';

export function formatSwapLine({ timestamp, stockName, side, quantity, price, fee, cash, equity }) {
    const notional = quantity * price;
    return chalk.gray(`${formatDate(new Date(+timestamp))} `) +
        chalk.bold(`${stockName.padEnd(7)} `) +
        (side === 'buy' ? chalk.greenBright(`BUY  `) : chalk.redBright(`SELL `)) +
        chalk.white(`${quantity.toLocaleString('en-US')} `.padEnd(8)) +
        chalk.white(`@ $${price.toLocaleString('en-US')} `.padEnd(10)) +
        chalk.gray(` | `) +
        chalk.white(`$${Math.round(notional).toLocaleString('en-US')}`.padEnd(11)) +
        chalk.white(` + $${Math.round(fee).toLocaleString('en-US')} fee`.padEnd(16)) +
        chalk.gray(`CASH $${Math.round(cash).toLocaleString('en-US')} | EQUITY $${Math.round(equity).toLocaleString('en-US')}`.padEnd(10));
}

export function formatTradeLine({ timestamp, stockName, market, dir, profit, profitPercent, holdMs, cash, equity, features }) {
    const holdTime = holdMs == null || !Number.isFinite(holdMs) ? '?' : ms(Math.max(0, holdMs));
    let line = chalk.gray(`${formatDate(new Date(+timestamp))} `) +
        chalk.bold(`${stockName.padEnd(market === 'crypto' ? 15 : 7)} `) +
        (dir < 0 ? chalk.magenta('SHORT ') : chalk.blue('LONG  ')) +
        chalk[profit > 0 ? 'green' : 'red'](
            `${profit > 0 ? '+$' : '-$'}${(+Math.abs(profit).toFixed(2)).toLocaleString('en-US').padEnd(10)} ` +
            `(${(profitPercent * 100).toFixed(1)}%)`.padEnd(12)
        ) +
        chalk.white(`${holdTime}`.padEnd(5)) +
        chalk.gray(`CASH $${Math.round(cash).toLocaleString('en-US')} | EQUITY $${Math.round(equity).toLocaleString('en-US')}`);
    if (features != null && features.length > 0) {
        line += chalk.cyan(` [${features.map(f => typeof f === 'number' ? f.toFixed(4) : f).join(', ')}]`);
    }
    return line;
}
