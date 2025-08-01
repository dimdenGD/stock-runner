import { sender, sql } from "../src/db.js";
import CSV from 'fast-csv';
import fs from 'fs';
import { eachDayOfInterval, format } from 'date-fns';

const startDate = new Date('2020-07-01');
const endDate = new Date();
const days = eachDayOfInterval({ start: startDate, end: endDate });


for (const day of days) {
    const start = new Date();
    const date = format(day, 'yyyy-MM-dd');
    const filename = `data/minute/${date}.csv`;
    if(!fs.existsSync(filename)) {
        continue;
    }
    const stream = fs.createReadStream(filename).pipe(CSV.parse({ headers: true, quote: null }));
    const promise = Promise.withResolvers();
    stream.on('data', async (row) => {
        await sender
            .table('candles_minute')
            .symbol('ticker', row.ticker)
            .floatColumn('open', +row.open)
            .floatColumn('high', +row.high)
            .floatColumn('low', +row.low)
            .floatColumn('close', +row.close)
            .intColumn('volume', +row.volume)
            .intColumn('transactions', +row.transactions)
            .at(+row.window_start / 1000000, 'ms');
        await sender.flush();
    });
    stream.on('end', () => {
        promise.resolve();
    });
    await promise.promise;
    const end = new Date();
    console.log(`Loaded ${date} in ${end - start}ms`);
}
