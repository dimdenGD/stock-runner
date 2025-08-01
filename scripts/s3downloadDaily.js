/**
 * This script downloads and decompresses historical daily candle data for the last 5 years
 * from Polygon.io's S3 flat files. It downloads files in parallel with a configurable rate limit.
 *
 * To use this script:
 * 1. Make sure you have a Polygon.io account with access to the flat files.
 * 2. Get your Access Key ID and Secret Access Key from your Polygon.io dashboard.
 * 3. Set the `POLYGON_ACCESS_KEY_ID` and `POLYGON_SECRET_ACCESS_KEY` environment variables,
 * or replace the placeholder values in the script.
 * 4. Optionally adjust the `RATE_LIMIT_PER_SECOND` and `YEARS_TO_DOWNLOAD` constants.
 * 5. Run the script from your terminal: `node polygon_s3_downloader.js`
 */

import 'dotenv/config';
import AWS from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import util from 'util';
import { format, eachDayOfInterval, subYears } from 'date-fns';

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
const downloadDir = './data_daily';

// --- Dynamic Date and Rate Configuration ---
const YEARS_TO_DOWNLOAD = 5;
const RATE_LIMIT_PER_SECOND = 50;
const DELAY_BETWEEN_BATCHES_MS = 1000;

// Calculate the start and end dates for the data you want to download
const endDate = new Date();
const startDate = subYears(endDate, YEARS_TO_DOWNLOAD);
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
    // console.log(`Decompressed file already exists, skipping: ${localFilePath}`);
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

  const datesToDownload = eachDayOfInterval({ start: startDate, end: endDate });
  const allFileKeys = datesToDownload.map(date => {
    const year = format(date, 'yyyy');
    const month = format(date, 'MM');
    const day = format(date, 'yyyy-MM-dd');
    return `us_stocks_sip/day_aggs_v1/${year}/${month}/${day}.csv.gz`;
  });

  console.log(`Preparing to download data for ${allFileKeys.length} days from ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}.`);
  console.log(`Rate limit: ${RATE_LIMIT_PER_SECOND} files per second.`);

  const allPromises = [];

  for (let i = 0; i < allFileKeys.length; i += RATE_LIMIT_PER_SECOND) {
    const chunk = allFileKeys.slice(i, i + RATE_LIMIT_PER_SECOND);
    
    // Start processing the chunk of files in parallel
    const chunkPromises = chunk.map(fileKey => downloadAndDecompressFile(fileKey));
    allPromises.push(...chunkPromises);

    console.log(`Batch of ${chunk.length} downloads initiated. Progress: ${Math.round((i + chunk.length) / allFileKeys.length * 100)}%`);
    
    // Wait for the specified delay before initiating the next batch
    if (i + RATE_LIMIT_PER_SECOND < allFileKeys.length) {
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  console.log("All download batches initiated. Waiting for all downloads to complete...");
  
  // Wait for all the promises from all batches to resolve
  await Promise.all(allPromises);

  console.log('--- Download process complete ---');
}

main();
