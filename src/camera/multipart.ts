/** Strict bounded parser for the firmware's Content-Length-delimited MJPEG stream. */
export class MultipartParser {
  private buffer: Buffer = Buffer.alloc(0);
  private length: number | null = null;
  readonly maxFrameBytes: number;
  constructor(maxFrameBytes = 512 * 1024) { this.maxFrameBytes = maxFrameBytes; }
  *push(chunk: Uint8Array): Generator<Buffer> {
    // Slice arbitrary input so a single malicious chunk cannot grow the retained buffer.
    for (let offset = 0; offset < chunk.byteLength; offset += 8192) {
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, offset + 8192)]);
      for (;;) {
        if (this.length === null) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (this.buffer.length > 4096) throw new Error('Camera header too large'); break; }
          if (end > 4096) throw new Error('Camera header too large');
          const header = this.buffer.subarray(0, end).toString('ascii').replace(/^\r\n/, '');
          const match = /^--taskpetframe\r\n/i.test(header) && /\r\nContent-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
          if (!match || !/\r\nContent-Type:\s*image\/jpeg\s*(?:\r\n|$)/i.test(header)) throw new Error('Invalid camera multipart header');
          const length = Number(match[1]);
          if (length < 4 || length > this.maxFrameBytes) throw new Error('Camera frame exceeds limit');
          this.length = length; this.buffer = this.buffer.subarray(end + 4);
        }
        if (this.buffer.length < this.length) break;
        const frame = Buffer.from(this.buffer.subarray(0, this.length));
        this.buffer = this.buffer.subarray(this.length); this.length = null;
        if (frame[0] !== 255 || frame[1] !== 216 || frame.at(-2) !== 255 || frame.at(-1) !== 217) throw new Error('Invalid camera JPEG');
        yield frame;
      }
    }
  }
  finish(): void {
    if (this.length !== null || this.buffer.toString('ascii').trim() !== '') throw new Error('Truncated camera stream');
  }
}
