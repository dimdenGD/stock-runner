import "dotenv/config";
import { Sender } from "@questdb/nodejs-client";
import postgres from 'postgres';

const sql = postgres("postgres://admin:quest@localhost:8812/qdb", {
    max: 4
});

await sql`
CREATE TABLE IF NOT EXISTS candles_daily (
        ticker SYMBOL CAPACITY 30000,
        open DOUBLE,
        high DOUBLE,
        low DOUBLE,
        close DOUBLE,
        volume LONG,
        transactions LONG,
        timestamp TIMESTAMP
    ) TIMESTAMP(timestamp) PARTITION BY WEEK
    DEDUP UPSERT KEYS(ticker, timestamp)
`;

await sql`
    CREATE TABLE IF NOT EXISTS candles_minute (
        ticker SYMBOL CAPACITY 30000,
        open DOUBLE,
        high DOUBLE,
        low DOUBLE,
        close DOUBLE,
        volume LONG,
        transactions LONG,
        timestamp TIMESTAMP
    ) TIMESTAMP(timestamp) PARTITION BY DAY
    DEDUP UPSERT KEYS(ticker, timestamp)
`;

export const sender = Sender.fromConfig("http::addr=localhost:9000;username=admin;password=quest;auto_flush_rows=1000;auto_flush_interval=3000;")
export { sql };