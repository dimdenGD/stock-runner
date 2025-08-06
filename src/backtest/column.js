/**
 * A column of values.
 * @param {Function} Type - The type of the values.
 * @param {number} initialCapacity - The initial capacity of the column.
 */
class Column {
    constructor(Type, initialCapacity = 500) {
        this.Type = Type;
        this.buffer = new Type(initialCapacity);
        this.length = 0;
    }

    /**
     * Push a value to the column.
     * @param {any} value - The value to push.
     */
    push(value) {
        if (this.length >= this.buffer.length) {
            // grow to 2× capacity
            const newBuf = new this.Type(this.buffer.length * 2);
            newBuf.set(this.buffer);
            this.buffer = newBuf;
        }
        this.buffer[this.length++] = value;
    }

    /**
     * Finish the column.
     * @returns {any[]} The finished column.
     */
    finish() {
        // shrink‐wrap to exact length
        return this.buffer.subarray(0, this.length);
    }
}

export default Column;