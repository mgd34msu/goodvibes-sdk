/**
 * The IMAP wire session: line-buffered reads, tagged commands, and literals.
 *
 * Split out of `imap-client.ts` so that file stays well inside the repository's
 * per-file line cap now that the client speaks four more commands. Nothing here
 * knows what a mailbox or a message is — it moves tagged commands and literal
 * payloads across a socket and hands back lines.
 *
 * Literals are counted in BYTES
 * ─────────────────────────────
 * `{n}` in IMAP is a byte count (RFC 3501 §4.3), and the socket is read with
 * `setEncoding('utf8')`, so the string this class accumulates has FEWER
 * characters than the server's byte count whenever the payload is not pure
 * ASCII. Taking `n` characters would swallow the bytes that follow the literal
 * — the closing `)` and, after it, the tagged completion line — and the read
 * would hang until it timed out. `takeUtf8Bytes` walks code points and counts
 * their UTF-8 width instead, which is what makes reading a message body with
 * an accented character in it work at all.
 *
 * The same arithmetic runs on the way out: `commandWithLiteral` declares
 * `Buffer.byteLength(payload)`, never `payload.length`.
 */

import type { Socket } from 'node:net';

const CRLF = '\r\n';

/**
 * Take the longest prefix of `text` that fits in `maxBytes` bytes of UTF-8,
 * and report how many bytes that prefix actually is.
 *
 * A surrogate pair is taken whole or not at all, so the returned prefix is
 * always valid text. If the very first character is already wider than the
 * budget — which means the server's byte count fell inside a multi-byte
 * sequence and cannot be honoured exactly — the character is taken anyway and
 * the whole remaining budget is reported as consumed, so a read always makes
 * progress rather than looping on a boundary it can never hit.
 */
export function takeUtf8Bytes(
  text: string,
  maxBytes: number,
): { readonly taken: string; readonly bytes: number } {
  if (maxBytes <= 0 || text.length === 0) return { taken: '', bytes: 0 };

  const whole = Buffer.byteLength(text, 'utf8');
  if (whole <= maxBytes) return { taken: text, bytes: whole };

  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    let width = 3;
    let units = 1;
    if (code < 0x80) {
      width = 1;
    } else if (code < 0x800) {
      width = 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      width = 4;
      units = 2;
    }
    if (bytes + width > maxBytes) break;
    bytes += width;
    index += units;
  }

  if (index === 0) {
    // The budget ends inside the first character. Consume it and call the
    // budget spent; see the doc comment.
    const units = /[\ud800-\udbff]/.test(text.charAt(0)) && text.length > 1 ? 2 : 1;
    return { taken: text.slice(0, units), bytes: maxBytes };
  }
  return { taken: text.slice(0, index), bytes };
}

/**
 * Wraps a Socket with line-buffered async reading and tagged command writing.
 * Owns a single shared read cursor; callers must not interleave awaits.
 */
export class ImapSession {
  private readonly socket: Socket;
  private readonly timeoutMs: number;
  private readonly literalCap: number;
  private buffer = '';
  private tagCounter = 0;

  constructor(socket: Socket, timeoutMs: number, literalCap: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.literalCap = literalCap;
    this.socket.setEncoding('utf8');
  }

  // -------------------------------------------------------------------------
  // Low-level I/O
  // -------------------------------------------------------------------------

  /** Read lines until the predicate returns the accumulated lines or null. */
  private async readUntil(
    predicate: (lines: string[]) => string[] | null,
  ): Promise<string[]> {
    const lines: string[] = [];

    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('IMAP read timeout'));
      }, this.timeoutMs);

      const onData = (chunk: string): void => {
        this.buffer += chunk;
        let pos: number;
        while ((pos = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, pos).replace(/\r$/, '');
          this.buffer = this.buffer.slice(pos + 1);
          lines.push(line);
          const result = predicate(lines);
          if (result !== null) {
            cleanup();
            resolve(result);
            return;
          }
        }
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onClose = (): void => {
        cleanup();
        reject(new Error('IMAP connection closed unexpectedly'));
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
      };

      this.socket.on('data', onData);
      this.socket.on('error', onError);
      this.socket.on('close', onClose);

      // Flush any already-buffered data
      if (this.buffer.length > 0) {
        onData('');
      }
    });
  }

  /** Read the server greeting. */
  async readGreeting(): Promise<void> {
    await this.readUntil((lines) => {
      const last = lines[lines.length - 1] ?? '';
      if (last.startsWith('* OK') || last.startsWith('* PREAUTH')) return lines;
      if (last.startsWith('* BYE')) return lines; // rejected
      return null;
    });
  }

  /** Send a tagged IMAP command and collect all response lines through completion. */
  async command(text: string): Promise<string[]> {
    const tag = this.nextTag();
    await this.write(`${tag} ${text}${CRLF}`);
    return this.readTaggedResponse(tag);
  }

  /**
   * Send a command whose final argument is a literal, e.g.
   * `APPEND Drafts (\Draft) {N}` followed by N bytes of message.
   *
   * N is `Buffer.byteLength(payload)`, not `payload.length`: a subject or body
   * with any non-ASCII character in it occupies more bytes than characters, and
   * a short count would leave the tail of the message being parsed as IMAP
   * commands. Waits for the server's `+` continuation before writing the
   * payload, and surfaces a `NO`/`BAD` sent instead of the continuation as the
   * same plain-language failure a normal command would raise.
   */
  async commandWithLiteral(commandPrefix: string, payload: string): Promise<string[]> {
    const tag = this.nextTag();
    const byteLength = Buffer.byteLength(payload, 'utf8');
    await this.write(`${tag} ${commandPrefix} {${byteLength}}${CRLF}`);
    await this.awaitContinuation(tag);
    await this.write(`${payload}${CRLF}`);
    return this.readTaggedResponse(tag);
  }

  /** Wait for the `+ ...` continuation request that precedes a literal write. */
  private async awaitContinuation(tag: string): Promise<void> {
    const lines = await this.readUntil((collected) => {
      const last = collected[collected.length - 1] ?? '';
      return last.startsWith('+') || last.startsWith(`${tag} `) ? collected : null;
    });
    const last = lines[lines.length - 1] ?? '';
    if (!last.startsWith('+')) {
      throw new Error(`IMAP command failed: ${last}`);
    }
  }

  private nextTag(): string {
    this.tagCounter += 1;
    return `A${String(this.tagCounter).padStart(4, '0')}`;
  }

  /**
   * Collect response lines for a tagged command, handling {n} literals.
   * A literal is signalled by a server response line ending with {<n>}.
   * We read exactly n BYTES of literal data then continue line reading.
   */
  private async readTaggedResponse(tag: string): Promise<string[]> {
    const lines: string[] = [];

    return new Promise<string[]>((resolve, reject) => {
      let literalBytesRemaining = 0;
      let literalAccum = '';
      let literalOwnerLine = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`IMAP command ${tag} timed out`));
      }, this.timeoutMs);

      const flush = (): void => {
        let pos: number;
        while (this.buffer.length > 0) {
          if (literalBytesRemaining > 0) {
            // Byte-counted, not character-counted — see the file header.
            const { taken, bytes } = takeUtf8Bytes(this.buffer, literalBytesRemaining);
            if (taken.length === 0) break; // need more data to complete a character
            literalAccum += taken;
            this.buffer = this.buffer.slice(taken.length);
            literalBytesRemaining -= bytes;
            if (literalBytesRemaining <= 0) {
              literalBytesRemaining = 0;
              lines.push(`${literalOwnerLine}${literalAccum}`);
              literalAccum = '';
              literalOwnerLine = '';
            }
            continue;
          }

          pos = this.buffer.indexOf('\n');
          if (pos === -1) break;

          const line = this.buffer.slice(0, pos).replace(/\r$/, '');
          this.buffer = this.buffer.slice(pos + 1);

          // Check for literal continuation
          const literalMatch = /\{(\d+)\}$/.exec(line);
          if (literalMatch) {
            const requested = parseInt(literalMatch[1] ?? '0', 10);
            // Cap server-supplied literal size to prevent memory exhaustion
            if (requested > this.literalCap) {
              cleanup();
              reject(new Error(
                `IMAP server sent an oversized literal ({${requested}} bytes, ` +
                `max allowed: ${this.literalCap}). The operation has been aborted.`,
              ));
              return;
            }
            literalBytesRemaining = requested;
            literalOwnerLine = line.slice(0, line.lastIndexOf('{')) + ' ';
            continue;
          }

          lines.push(line);

          // Tagged completion
          if (line.startsWith(`${tag} OK`) || line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
            cleanup();
            if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
              reject(new Error(`IMAP command failed: ${line}`));
            } else {
              resolve(lines);
            }
            return;
          }
        }
      };

      const onData = (chunk: string): void => {
        this.buffer += chunk;
        flush();
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onClose = (): void => {
        cleanup();
        reject(new Error('IMAP connection closed during command'));
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
      };

      this.socket.on('data', onData);
      this.socket.on('error', onError);
      this.socket.on('close', onClose);

      // Flush already-buffered data
      flush();
    });
  }

  private write(data: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket.write(data, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  destroy(): void {
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }
}
