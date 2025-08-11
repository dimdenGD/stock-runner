import { sender, sql } from "../src/db.js";
import fs from 'fs';
import { eachDayOfInterval, format, addDays } from 'date-fns';
import path from 'path';
import { Temporal } from '@js-temporal/polyfill';

const type = process.argv[2];

if (!['1d', '1h', '5m'].includes(type)) {
    console.error('Usage: node stooq_ingest.js <1d|1h|5m>');
    process.exit(1);
}

let startDate = new Date('2003-07-01');
let endDate = new Date();

const lastDate = await sql`SELECT timestamp FROM ${sql(`candles_${type}`)} ORDER BY timestamp DESC LIMIT 1`;
if(lastDate.length > 0) {
    startDate = addDays(new Date(lastDate[0].timestamp), 1);
    console.log(`Last date in database: ${format(startDate, 'yyyy-MM-dd')}`);
}

startDate = startDate.getTime();
endDate = endDate.getTime();

function lineReader(inputFile, callback) {
    return new Promise((resolve, reject) => {
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
            callback(remaining || '');
            resolve();
        });

        inputStream.on('error', (err) => {
            reject(err);
        });
    });
}

async function processMarket(folderPath) {
    const files = fs.readdirSync(folderPath);
    for(const i in files) {
        const file = files[i];
        if(!file.endsWith('.txt')) continue;
        console.log(`Processing ${file.split('.')[0].toUpperCase()} (${((i / files.length) * 100).toFixed(2)}%)`);
        let errored = false;
        await lineReader(path.join(folderPath, file), async (line) => {
            if(line.length < 8) return;
            if(errored) return;
            // <TICKER>,<PER>,<DATE>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<VOL>,<OPENINT>
            // AAPL.US,D,19840907,000000,0.0996047,0.100827,0.0984022,0.0996047,98811715,0
            // <DATE> = YYYYMMDD
            // <TIME> = HHMMSS
            const [ticker, per, date, time, open, high, low, close, volume] = line.trim().split(',');
            if(per === '<PER>') return; // skip header

            let timestamp;
            if(type !== '1d') {
                timestamp = Temporal.ZonedDateTime.from({
                    timeZone: 'Europe/Warsaw', // stooq is a polish site
                    year: date.slice(0, 4),
                    month: date.slice(4, 6),
                    day: date.slice(6, 8),
                    hour: time.slice(0, 2),
                    minute: time.slice(2, 4),
                    second: time.slice(4, 6),
                });
            } else {
                // force 16:00 EST
                timestamp = Temporal.ZonedDateTime.from({
                    timeZone: 'America/New_York',
                    year: date.slice(0, 4),
                    month: date.slice(4, 6),
                    day: date.slice(6, 8),
                    hour: 16,
                });
            }

            const ms = timestamp.epochMilliseconds;
            if(ms < startDate || ms > endDate) return;
            
            try {
                await sender
                    .table(`candles_${type}`)
                    .symbol('ticker', ticker.split(".").slice(0, -1))
                    .floatColumn('open', +open)
                    .floatColumn('high', +high)
                    .floatColumn('low', +low)
                    .floatColumn('close', +close)
                    .intColumn('volume', Math.round(+volume))
                    .at(ms, 'ms');
            } catch(e) {
                errored = true;
                console.log(line);
                throw e;
            }
        });
    }
}

const markets = fs.readdirSync(`./data/stooq/`);
for(const market of markets) {
    if(!market.endsWith(' stocks')) continue;
    console.log(`Processing ${market}`);
    const files = fs.readdirSync(`./data/stooq/${market}`);
    if(files.includes('1')) {
        for(const folder of files) {
            await processMarket(`./data/stooq/${market}/${folder}`);
        }
    } else {
        await processMarket(`./data/stooq/${market}`);
    }
}