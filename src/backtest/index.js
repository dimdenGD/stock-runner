import { loadDaily, loadMinute } from './loader.js';

const stock = await loadDaily('GOOG', new Date('2020-07-01'), new Date());

for(const candle of stock) {
    console.log(candle);
}