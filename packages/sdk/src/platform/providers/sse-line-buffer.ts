/**
 * Canonical SSE line-buffer — handles both LF (\n) and CRLF (\r\n) line endings.
 * Standardised on /\r?\n/ per RFC 7230 and the W3C SSE spec.
 */
export class SseLineBuffer {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  /** Feed a raw chunk and return all complete lines (without line endings). */
  feed(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? '';
    return parts;
  }

  /** Return any buffered incomplete line after the stream ends. */
  flush(): string[] {
    if (!this.buffer) return [];
    const line = this.buffer;
    this.buffer = '';
    return [line];
  }
}
