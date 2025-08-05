/**
 * Calculate the percentage difference between two numbers.
 * 
 * @param {number} original - The starting value.
 * @param {number} updated  - The new value.
 * @returns {number} The percentage change from original to updated.
 *                   Positive if updated > original, negative if updated < original.
 */
export function percentageDifference(original, updated) {
    if (original === 0) {
        // Avoid division by zero; define as Infinity or handle as you see fit
        return updated === 0 ? 0 : (updated > 0 ? Infinity : -Infinity);
    }
    return ((updated - original) / original) * 100;
}

export function formatDate(date) {
    const weekDay = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: "UTC" });
    const month = date.toLocaleDateString('en-US', { month: 'short', timeZone: "UTC" });
    const day = date.toLocaleDateString('en-US', { day: 'numeric', timeZone: "UTC" });
    return `${month} ${day.padStart(2, '0')} ${weekDay} ${date.toISOString().split(':').slice(0, 2).join(':').split('T').join(' ')}`;
}

export function splitArray(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
    }
    return result;
}