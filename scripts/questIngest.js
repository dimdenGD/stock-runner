import { sender, sql } from "../src/db.js";
import fs from 'fs';
import { eachDayOfInterval, format, addDays } from 'date-fns';

const type = process.argv[2];

if (!['1d', '1m'].includes(type)) {
    console.error('Usage: node questIngest.js <1d|1m>');
    process.exit(1);
}

let startDate = new Date('2020-07-01');
const endDate = new Date();

const lastDate = await sql`SELECT timestamp FROM ${sql(`candles_${type}`)} ORDER BY timestamp DESC LIMIT 1`;
if(lastDate.length > 0) {
    startDate = addDays(new Date(lastDate[0].timestamp), 1);
    console.log(`Last date in database: ${format(startDate, 'yyyy-MM-dd')}`);
}

const days = eachDayOfInterval({ start: startDate, end: endDate });

function lineReader(inputFile, callback) {
    let inputStream = fs.createReadStream(inputFile, { encoding: 'utf-8' })
    let remaining = ''

    inputStream.on('data', (chunk) => {
        remaining += chunk;

        let index = remaining.indexOf('\n')
        let last = 0;

        while (index > -1) {
            let line = remaining.substring(last, index)
            last = (index + 1)

            callback(line)

            index = remaining.indexOf('\n', last)
        }

        remaining = remaining.substring(last)
    })

    inputStream.on('end', () => {
        callback(remaining || '', true)
    })
}

for (const day of days) {
    const start = new Date();
    const date = format(day, 'yyyy-MM-dd');
    const filename = `data/${type}/${date}.csv`;
    if(!fs.existsSync(filename)) {
        continue;
    }
    const promise = Promise.withResolvers();
    lineReader(filename, async (line, done) => {
        if(done) {
            promise.resolve();
            return;
        }
        const arr = line.split(',');
        if(arr[0] === 'ticker' || arr.length !== 8) {
            return;
        }
        try {
            await sender
                .table(`candles_${type}`)
                .symbol('ticker', arr[0])
                .floatColumn('open', +arr[2])
                .floatColumn('high', +arr[4])
                .floatColumn('low', +arr[5])
                .floatColumn('close', +arr[3])
                .intColumn('volume', +arr[1])
                .intColumn('transactions', +arr[7])
                .at(+arr[6] / 1000000, 'ms');
        } catch (e) {
            console.log(arr);
            throw e;
        }
    });
    await promise.promise;
    const end = new Date();
    console.log(`Loaded ${date} in ${end - start}ms`);
}
sender.flush();
await new Promise(resolve => setTimeout(resolve, 5000)); // give time to flush

console.log('Done');
await sender.close();
await sql.end();