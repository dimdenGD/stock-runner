import BinanceKlineStream from '../src/forward/binanceKlineStream.js';

const symbol = String(process.argv[2] || 'BTCUSDT').toUpperCase();
const interval = String(process.argv[3] || '15m');
const timeoutMs = Number(process.argv[4] || 10000);
const intervalMs = {
    '1m': 60000, '5m': 300000, '15m': 900000,
    '1h': 3600000, '4h': 14400000, '1d': 86400000,
}[interval];

if (!intervalMs) throw new Error(`Unsupported interval: ${interval}`);

const stream = new BinanceKlineStream({
    symbols: [symbol],
    interval,
    stepMs: intervalMs,
    staleMs: Math.max(90000, timeoutMs * 2),
});

try {
    await stream.start();
    const health = await stream.waitForData(timeoutMs);
    console.log(`PASS: received Binance Futures market data (${health.dataMessages} message)`);
} catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
} finally {
    await stream.stop();
}

process.exit(process.exitCode || 0);
