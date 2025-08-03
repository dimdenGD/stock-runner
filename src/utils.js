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
