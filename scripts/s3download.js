/**
 * This script downloads and decompresses historical daily candle data for the last 5 years
 * from Polygon.io's S3 flat files. It downloads files in parallel with a configurable rate limit.
 *
 * To use this script:
 * 1. Make sure you have a Polygon.io account with access to the flat files.
 * 2. Get your Access Key ID and Secret Access Key from your Polygon.io dashboard.
 * 3. Set the `POLYGON_ACCESS_KEY_ID` and `POLYGON_SECRET_ACCESS_KEY` environment variables,
 * 4. Optionally adjust the `RATE_LIMIT` and `YEARS_TO_DOWNLOAD` constants.
 * 5. Run the script from your terminal: `node scripts/s3download.js <daily|minute>`
 */

import 'dotenv/config';
import AWS from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import util from 'util';
import { format, eachDayOfInterval, subYears } from 'date-fns';
import { sql } from '../src/db.js';

const type = process.argv[2];
const typeMap = {
  '1d': 'day',
  '1m': 'minute',
}

if (!['1d', '1m'].includes(type)) {
  console.error('Usage: node s3download.js <1d|1m>');
  process.exit(1);
}

// Promisify the zlib.gunzip function for use with async/await
const gunzip = util.promisify(zlib.gunzip);

// --- Configuration ---

// Your Polygon.io S3 Credentials
// For better security, use environment variables instead of hardcoding your credentials.
const accessKeyId = process.env.POLYGON_ACCESS_KEY_ID || 'YOUR_POLYGON_ACCESS_KEY_ID';
const secretAccessKey = process.env.POLYGON_SECRET_ACCESS_KEY || 'YOUR_SECRET_ACCESS_KEY';

// The S3 endpoint for Polygon.io flat files
const endpoint = 'https://files.polygon.io';

// The S3 bucket name
const bucketName = 'flatfiles';

// The directory where you want to save the downloaded and decompressed files
const downloadDir = `./data/${type}`;

// --- Dynamic Date and Rate Configuration ---
const YEARS_TO_DOWNLOAD = isFinite(+process.env.YEARS_TO_DOWNLOAD) ? +process.env.YEARS_TO_DOWNLOAD : 5;
const RATE_LIMIT = isFinite(+process.env.RATE_LIMIT) ? +process.env.RATE_LIMIT : 10;

// Calculate the start and end dates for the data you want to download
const endDate = new Date();
let startDate = subYears(endDate, YEARS_TO_DOWNLOAD);
endDate.setDate(endDate.getDate() - 1); // current day is not available


// --- End of Configuration ---

// Configure the AWS SDK
const s3 = new AWS.S3({
  endpoint: new AWS.Endpoint(endpoint),
  accessKeyId: accessKeyId,
  secretAccessKey: secretAccessKey,
  s3ForcePathStyle: true, // Required for custom endpoints
});

/**
 * Creates the download directory if it doesn't already exist.
 */
function createDownloadDirectory() {
  if (!fs.existsSync(downloadDir)) {
    console.log(`Creating download directory: ${downloadDir}`);
    fs.mkdirSync(downloadDir, { recursive: true });
  }
}

/**
 * Downloads a single file from the Polygon.io S3 bucket and decompresses it.
 * @param {string} fileKey The key of the .csv.gz file to download.
 */
async function downloadAndDecompressFile(fileKey) {
  const decompressedFileName = path.basename(fileKey).replace('.gz', '');
  const localFilePath = path.join(downloadDir, decompressedFileName);

  if (fs.existsSync(localFilePath)) {
    // Silently skip if file exists to reduce log noise in parallel execution.
    console.log(`Decompressed file already exists, skipping: ${localFilePath}`);
    return;
  }

  const params = {
    Bucket: bucketName,
    Key: fileKey,
  };

  try {
    // 1. Download the gzipped file from S3
    const compressedData = await s3.getObject(params).promise();

    // 2. Decompress the data
    const decompressedData = await gunzip(compressedData.Body);

    // 3. Write the decompressed data to a .csv file
    fs.writeFileSync(localFilePath, decompressedData);
    console.log(`Successfully processed: ${decompressedFileName}`);
  } catch (err) {
    if (err.code === 'NoSuchKey') {
      // This is expected for dates with no trading activity (weekends, holidays)
      // console.warn(`File not found on server: ${fileKey}`);
    } else {
      console.error(`Error processing ${fileKey}:`, err.code);
    }
  }
}

/**
 * The main function that orchestrates the download process.
 */
async function main() {
  console.log('--- Polygon.io S3 Downloader ---');

  if (accessKeyId === 'YOUR_POLYGON_ACCESS_KEY_ID' || secretAccessKey === 'YOUR_SECRET_ACCESS_KEY') {
    console.error('Please configure your Polygon.io Access Key ID and Secret Access Key.');
    return;
  }

  createDownloadDirectory();

  const lastDate = await sql`SELECT timestamp FROM ${sql(`candles_${type}`)} ORDER BY timestamp DESC LIMIT 1`;
  if(lastDate.length > 0) {
    startDate = new Date(lastDate[0].timestamp);
    console.log(`Last date in database: ${format(startDate, 'yyyy-MM-dd')}`);
  }
  
  const datesToDownload = eachDayOfInterval({ start: startDate, end: endDate });

  const allFileKeys = datesToDownload.map(date => {
    const year = format(date, 'yyyy');
    const month = format(date, 'MM');
    const day = format(date, 'yyyy-MM-dd');
    return `us_stocks_sip/${typeMap[type]}_aggs_v1/${year}/${month}/${day}.csv.gz`;
  });

  console.log(`Preparing to download data for ${allFileKeys.length} days from ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}.`);
  console.log(`Rate limit: ${RATE_LIMIT} files per second.`);

  
  for (let i = 0; i < allFileKeys.length; i += RATE_LIMIT) {
    const chunk = allFileKeys.slice(i, i + RATE_LIMIT);
    
    // Start processing the chunk of files in parallel
    const chunkPromises = chunk.map(fileKey => downloadAndDecompressFile(fileKey));

    console.log(`Batch of ${chunk.length} downloads initiated. Progress: ${Math.round((i + chunk.length) / allFileKeys.length * 100)}%`);
    
    await Promise.all(chunkPromises);
  }

  console.log('--- Download process complete ---');
}

main();
