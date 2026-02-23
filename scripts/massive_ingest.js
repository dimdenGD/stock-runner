import { sender, sql } from "../src/db.js";
import fs from 'fs';

const type = process.argv[2];

if (!['1d', '1h', '5m', '1m'].includes(type)) {
    console.error('Usage: node massive_ingest.js <1d|1h|5m|1m>');
    process.exit(1);
}

const toAdd = {
    '1d': 60000*60*16, // 4pm
    '1h': 60000*60, // 1 hour
    '5m': 60000*5, // 5 minutes
    '1m': 60000, // 1 minute
}

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

const tickers = fs.readdirSync(`data/massive/${type}`).map(f => f.split('.').slice(0, -1).join('.'));
for(const ticker of tickers) {
    const promise = Promise.withResolvers();
    console.log(`Processing ${ticker}...`);
    lineReader(`data/massive/${type}/${ticker}.csv`, async (line, done) => {
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
                .intColumn('volume', parseInt(arr[1]))
                .at(+arr[6] + toAdd[type], 'ms');
        } catch (e) {
            console.log(arr);
            throw e;
        }
    });
    await promise.promise;
}
sender.flush();
await new Promise(resolve => setTimeout(resolve, 5000)); // give time to flush

console.log('Done');
await sender.close();
await sql.end();