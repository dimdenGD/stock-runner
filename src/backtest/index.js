import { loadAllDaily } from './loader.js';

const stocks = await loadAllDaily(new Date('2020-07-01'), new Date());

console.log(stocks);

setInterval(() => {
    console.log(stocks['AAPL'].size);
}, 1000);