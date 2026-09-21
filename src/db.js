import "dotenv/config";
import { Sender } from "@questdb/nodejs-client";
import postgres from 'postgres';

const USERNAME = process.env.QUESTDB_USERNAME || 'admin';
const PASSWORD = process.env.QUESTDB_PASSWORD || 'quest';
const HOST = process.env.QUESTDB_HOST || 'localhost';
const PORT = process.env.QUESTDB_PORT || 8812;
const DATABASE = process.env.QUESTDB_DATABASE || 'qdb';

const sql = postgres(`postgres://${USERNAME}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}`, {
    max: 4,
    connection: {
        timezone: "UTC",
    },
});

export async function createTables() {
    await sql`
    CREATE TABLE IF NOT EXISTS candles_1d (
            ticker SYMBOL CAPACITY 30000,
            open DOUBLE,
            high DOUBLE,
            low DOUBLE,
            close DOUBLE,
            volume LONG,
            timestamp TIMESTAMP
        ), INDEX(ticker) TIMESTAMP(timestamp) PARTITION BY MONTH
        DEDUP UPSERT KEYS(timestamp, ticker)
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS candles_1m (
            ticker SYMBOL CAPACITY 30000,
            open DOUBLE,
            high DOUBLE,
            low DOUBLE,
            close DOUBLE,
            volume LONG,
            timestamp TIMESTAMP
        ), INDEX(ticker) TIMESTAMP(timestamp) PARTITION BY DAY
        DEDUP UPSERT KEYS(timestamp, ticker)
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS candles_5m (
            ticker SYMBOL CAPACITY 30000,
            open DOUBLE,
            high DOUBLE,
            low DOUBLE,
            close DOUBLE,
            volume LONG,
            timestamp TIMESTAMP
        ), INDEX(ticker) TIMESTAMP(timestamp) PARTITION BY DAY
        DEDUP UPSERT KEYS(timestamp, ticker)
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS candles_1h (
            ticker SYMBOL CAPACITY 30000,
            open DOUBLE,
            high DOUBLE,
            low DOUBLE,
            close DOUBLE,
            volume LONG,
            timestamp TIMESTAMP
        ), INDEX(ticker) TIMESTAMP(timestamp) PARTITION BY DAY
        DEDUP UPSERT KEYS(timestamp, ticker)
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS candles_15m (
            ticker SYMBOL CAPACITY 30000,
            open DOUBLE,
            high DOUBLE,
            low DOUBLE,
            close DOUBLE,
            volume LONG,
            timestamp TIMESTAMP
        ), INDEX(ticker) TIMESTAMP(timestamp) PARTITION BY DAY
        DEDUP UPSERT KEYS(timestamp, ticker)
    `;

    for (const iv of ['1m', '5m', '15m', '1h', '4h', '1d']) {
        await sql.unsafe(`
            CREATE TABLE IF NOT EXISTS crypto_candles_${iv} (
                ticker SYMBOL CAPACITY 30000,
                open DOUBLE,
                high DOUBLE,
                low DOUBLE,
                close DOUBLE,
                volume DOUBLE,
                quote_volume DOUBLE,
                timestamp TIMESTAMP
            ), INDEX(ticker) TIMESTAMP(timestamp) PARTITION BY ${['1h', '4h', '1d'].includes(iv) ? 'MONTH' : 'DAY'}
            DEDUP UPSERT KEYS(timestamp, ticker)
        `);
    }

    await sql`
        CREATE TABLE IF NOT EXISTS crypto_funding (
            ticker SYMBOL CAPACITY 30000,
            rate DOUBLE,
            interval_hours INT,
            timestamp TIMESTAMP
        ), INDEX(ticker) TIMESTAMP(timestamp) PARTITION BY MONTH
        DEDUP UPSERT KEYS(timestamp, ticker)
    `;
}

export const sender = Sender.fromConfig(`http::addr=${HOST}:9000;username=${USERNAME};password=${PASSWORD};auto_flush_rows=1000;auto_flush_interval=3000;`)
export { sql };