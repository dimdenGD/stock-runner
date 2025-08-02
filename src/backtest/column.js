class Column {
    constructor(Type, initialCapacity = 1_000) {
        this.Type = Type;
        this.buffer = new Type(initialCapacity);
        this.length = 0;
    }

    push(value) {
        if (this.length >= this.buffer.length) {
            // grow to 2× capacity
            const newBuf = new this.Type(this.buffer.length * 2);
            newBuf.set(this.buffer);
            this.buffer = newBuf;
        }
        this.buffer[this.length++] = value;
    }

    finish() {
        // shrink‐wrap to exact length
        return this.buffer.subarray(0, this.length);
    }
}

export default Column;