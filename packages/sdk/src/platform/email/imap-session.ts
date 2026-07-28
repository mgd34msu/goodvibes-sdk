/**
 * The IMAP wire session: one persistent reader per connection, tagged
 * commands, untagged dispatch, and literals.
 *
 * Split out of `imap-client.ts` so that file stays well inside the repository's
 * per-file line cap now that the client speaks four more commands. Nothing here
 * knows what a mailbox or a message is — it moves tagged commands and literal
 * payloads across a socket and hands back lines.
 *
 * One reader owns the socket for the connection's lifetime
 * ────────────────────────────────────────────────────────
 * An earlier shape attached `data`/`error`/`close` listeners for the duration
 * of one command and removed them when it completed. Between commands nothing
 * was listening, so anything the server sent on its own initiative — which is
 * every interesting thing a server says, `* n EXISTS` above all — landed in a
 * buffer that the next command discarded. Worse, the leftover bytes of a
 * response that arrived in the same TCP segment as the previous one went with
 * it.
 *
 * So the listeners are attached once, in the constructor, and removed once, in
 * `destroy()`. A single `drain()` turns the byte stream into complete logical
 * lines and routes each one:
 *
 *   - a `+ ...` continuation goes to the command waiting for one;
 *   - a `<tag> OK|NO|BAD` line completes the command issued under that tag,
 *     whether or not anybody is awaiting it yet;
 *   - anything else is collected for the command currently in flight, and
 *     every untagged `* ...` line is additionally offered to subscribers.
 *
 * Untagged lines are offered to subscribers whether or not a command is in
 * flight, because that is the only rule that works for IDLE: the untagged
 * `EXISTS` that IDLE exists to receive arrives while the `IDLE` command itself
 * is still outstanding. Subscribers therefore see untagged data belonging to
 * commands they did not issue and must filter for what they care about.
 *
 * Reads have a deadline by default and none on request
 * ────────────────────────────────────────────────────
 * Ordinary commands keep the per-operation timeout they always had. A caller
 * that must wait in silence for half an hour — again, IDLE — passes
 * `timeoutMs: null` and bounds the wait with an `AbortSignal` instead. There is
 * no path where a wait is unbounded in both.
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
 * How many completed-but-never-awaited commands are remembered.
 *
 * Every `sendCommand` registers a slot that `awaitTag` consumes. A caller that
 * issues a command and never awaits it would otherwise leave that slot — and
 * the response lines in it — retained for the life of the connection.
 */
const MAX_UNCONSUMED_COMPLETIONS = 32;

/**
 * The most response lines one command will retain before giving up on it.
 *
 * A command collects every line that arrives while it is in flight, which is
 * right for a FETCH and wrong for a command that stays in flight for
 * twenty-seven minutes: IDLE is the steady state of a daemon that runs for
 * weeks, and on a busy mailbox its line array would grow for the whole round
 * with nothing consuming it. Long-lived callers opt out with
 * `retainUntagged: false` and read the stream through `onUntagged` instead.
 *
 * This ceiling is the backstop for everyone else. It FAILS the command rather
 * than dropping lines out of it: a silently shortened response is a wrong
 * answer, and a wrong answer about which messages exist is exactly the kind
 * that gets written to a cursor. No real response comes close to it.
 */
const MAX_COMMAND_LINES = 100_000;

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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Receives one untagged (`* ...`) response line.
 *
 * The line is complete: a response whose payload arrived as a `{n}` literal is
 * delivered with that payload folded onto the end of its own line, exactly as
 * a tagged command would collect it.
 */
export type ImapUntaggedListener = (line: string) => void;

/** What a caller wants kept while a command is in flight. */
export interface ImapSendOptions {
  /**
   * Collect untagged lines into this command's response. Default true, which
   * is what an ordinary request/response command needs.
   *
   * IDLE sets it false: it stays in flight for up to twenty-seven minutes, its
   * untagged traffic is delivered to subscribers as it arrives, and a second
   * retained copy would be an array that grows for the whole round with
   * nothing reading it. The tagged completion is still collected either way.
   */
  readonly retainUntagged?: boolean | undefined;
}

/** How long a single wait may last, and what may cancel it. */
export interface ImapReadOptions {
  /**
   * Deadline in milliseconds. Omitted means the session's per-operation
   * timeout. `null` means NO deadline: the wait ends when the awaited response
   * arrives, when the socket fails, or when `signal` aborts — and nothing else.
   */
  readonly timeoutMs?: number | null;
  /** Cancels the wait. Required in practice whenever `timeoutMs` is null. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * The wire operations a protocol extension living beside this module needs.
 *
 * This exists for IDLE, which cannot be expressed as "send a command, read its
 * response": it sends `IDLE`, waits for a `+`, then reads untagged responses
 * for up to twenty-seven minutes, then sends the bare line `DONE` — which is
 * not a tagged command — and only then collects the completion of the tag it
 * issued at the start.
 *
 * It is deliberately NOT reachable from `ImapClient`'s own method surface and
 * is not re-exported from `email/index.ts`. Holding a client does not give
 * anybody a way to put arbitrary bytes on the mailbox connection.
 */
export interface ImapConnection {
  /** Subscribe to untagged responses. Returns the unsubscribe function. */
  onUntagged(listener: ImapUntaggedListener): () => void;
  /** Send a tagged command and return its tag without awaiting completion. */
  sendCommand(text: string, options?: ImapSendOptions): Promise<string>;
  /** Write one bare line that is not a tagged command, e.g. IDLE's `DONE`. */
  sendRawLine(text: string): Promise<void>;
  /** Await the `+ ...` continuation request for a command already in flight. */
  awaitContinuation(tag: string, options?: ImapReadOptions): Promise<void>;
  /** Await the tagged completion of a command issued earlier under `tag`. */
  awaitTag(tag: string, options?: ImapReadOptions): Promise<string[]>;
  /** Await the first untagged line the predicate accepts. */
  waitForUntagged(
    matches: (line: string) => boolean,
    options?: ImapReadOptions,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingCommand {
  readonly tag: string;
  readonly lines: string[];
  /**
   * Whether untagged lines are collected for this command at all.
   *
   * False for a command that stays in flight indefinitely and reads the
   * stream through subscribers — the untagged traffic is consumed there, and
   * retaining a second copy for a response nobody will read is pure growth.
   */
  readonly retainUntagged: boolean;
  /** The status word of the tagged completion, or null while in flight. */
  completion: 'OK' | 'NO' | 'BAD' | null;
  /** The tagged completion line verbatim, for the failure message. */
  completionLine: string;
  /** Continuation requests received but not yet consumed by a waiter. */
  continuations: number;
  waiter: Waiter<string[]> | null;
  continuationWaiter: Waiter<void> | null;
}

interface UntaggedWaiter {
  readonly matches: (line: string) => boolean;
  readonly waiter: Waiter<string>;
}

/**
 * Wraps a Socket with a persistent line reader, tagged command writing, and
 * untagged response dispatch. One instance per connection, for the life of the
 * connection.
 */
export class ImapSession implements ImapConnection {
  private readonly socket: Socket;
  private readonly timeoutMs: number;
  private readonly literalCap: number;

  private buffer = '';
  private tagCounter = 0;

  private literalBytesRemaining = 0;
  private literalAccum = '';
  private literalOwnerLine = '';

  private readonly pending = new Map<string, PendingCommand>();
  private readonly untaggedListeners = new Set<ImapUntaggedListener>();
  private readonly untaggedWaiters = new Set<UntaggedWaiter>();

  private greetingWaiter: Waiter<string> | null = null;
  private greetingSeen = false;
  private greetingLine = '';
  private failure: Error | null = null;
  private destroyed = false;

  private readonly onData = (chunk: string): void => {
    this.buffer += chunk;
    this.drain();
  };

  private readonly onSocketError = (error: Error): void => {
    this.fail(error, error);
  };

  private readonly onSocketClose = (): void => {
    this.fail(
      new Error('IMAP connection closed during command'),
      new Error('IMAP connection closed unexpectedly'),
    );
  };

  constructor(socket: Socket, timeoutMs: number, literalCap: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.literalCap = literalCap;
    this.socket.setEncoding('utf8');
    this.socket.on('data', this.onData);
    this.socket.on('error', this.onSocketError);
    this.socket.on('close', this.onSocketClose);
  }

  // -------------------------------------------------------------------------
  // Reading: one drain loop, one router
  // -------------------------------------------------------------------------

  /** Turn buffered bytes into complete logical lines and route each one. */
  private drain(): void {
    if (this.failure !== null) {
      this.buffer = '';
      return;
    }
    for (;;) {
      if (this.literalBytesRemaining > 0) {
        if (this.buffer.length === 0) return;
        // Byte-counted, not character-counted — see the file header.
        const { taken, bytes } = takeUtf8Bytes(this.buffer, this.literalBytesRemaining);
        if (taken.length === 0) return; // need more data to complete a character
        this.literalAccum += taken;
        this.buffer = this.buffer.slice(taken.length);
        this.literalBytesRemaining -= bytes;
        if (this.literalBytesRemaining <= 0) {
          this.literalBytesRemaining = 0;
          const record = `${this.literalOwnerLine}${this.literalAccum}`;
          this.literalAccum = '';
          this.literalOwnerLine = '';
          this.route(record);
          if (this.failure !== null) return;
        }
        continue;
      }

      const pos = this.buffer.indexOf('\n');
      if (pos === -1) return;
      const line = this.buffer.slice(0, pos).replace(/\r$/, '');
      this.buffer = this.buffer.slice(pos + 1);

      const literalMatch = /\{(\d+)\}$/.exec(line);
      if (literalMatch) {
        const requested = parseInt(literalMatch[1] ?? '0', 10);
        // Cap server-supplied literal size to prevent memory exhaustion. The
        // stream cannot be parsed past a literal we refuse to read, so this
        // ends the connection rather than one command.
        if (requested > this.literalCap) {
          this.failStream(new Error(
            `IMAP server sent an oversized literal ({${requested}} bytes, ` +
            `max allowed: ${this.literalCap}). The operation has been aborted.`,
          ));
          return;
        }
        this.literalBytesRemaining = requested;
        this.literalOwnerLine = line.slice(0, line.lastIndexOf('{')) + ' ';
        continue;
      }

      this.route(line);
      if (this.failure !== null) return;
    }
  }

  /** Send one complete response line to whoever it belongs to. */
  private route(line: string): void {
    if (!this.greetingSeen && !line.startsWith('+') && line.startsWith('* ')) {
      // The greeting arrives unprompted, so it may well be here before
      // `readGreeting()` is called. Recorded either way.
      if (line.startsWith('* OK') || line.startsWith('* PREAUTH') || line.startsWith('* BYE')) {
        this.greetingSeen = true;
        this.greetingLine = line;
        const waiter = this.greetingWaiter;
        this.greetingWaiter = null;
        waiter?.resolve(line);
        return;
      }
    }

    if (line.startsWith('+')) {
      const target = this.oldestOpenCommand();
      if (target === undefined) return;
      const waiter = target.continuationWaiter;
      if (waiter !== null) {
        target.continuationWaiter = null;
        waiter.resolve();
      } else {
        target.continuations += 1;
      }
      return;
    }

    const tagged = /^(\S+) (OK|NO|BAD)\b/.exec(line);
    const taggedTag = tagged?.[1] ?? '';
    const command = taggedTag.length > 0 ? this.pending.get(taggedTag) : undefined;
    if (command !== undefined && command.completion === null) {
      const status = tagged?.[2];
      command.lines.push(line);
      command.completion = status === 'NO' ? 'NO' : status === 'BAD' ? 'BAD' : 'OK';
      command.completionLine = line;
      this.settle(command);
      return;
    }

    const open = this.oldestOpenCommand();
    if (open !== undefined && open.retainUntagged) {
      if (open.lines.length >= MAX_COMMAND_LINES) {
        this.failStream(new Error(
          `IMAP command ${open.tag} received more than ${MAX_COMMAND_LINES} `
          + `response lines without completing. The connection has been closed `
          + `rather than kept growing.`,
        ));
        return;
      }
      open.lines.push(line);
    }
    if (line.startsWith('*')) this.dispatchUntagged(line);
  }

  /** The command whose response lines are currently arriving, if any. */
  private oldestOpenCommand(): PendingCommand | undefined {
    for (const command of this.pending.values()) {
      if (command.completion === null) return command;
    }
    return undefined;
  }

  private settle(command: PendingCommand): void {
    const continuation = command.continuationWaiter;
    if (continuation !== null) {
      command.continuationWaiter = null;
      continuation.reject(new Error(`IMAP command failed: ${command.completionLine}`));
    }
    const waiter = command.waiter;
    if (waiter === null) {
      this.forgetOldestCompletions();
      return;
    }
    command.waiter = null;
    this.pending.delete(command.tag);
    if (command.completion === 'OK') waiter.resolve([...command.lines]);
    else waiter.reject(new Error(`IMAP command failed: ${command.completionLine}`));
  }

  /** Drop the oldest completions nobody ever awaited; see the constant. */
  private forgetOldestCompletions(): void {
    let unconsumed = 0;
    for (const command of this.pending.values()) {
      if (command.completion !== null) unconsumed += 1;
    }
    for (const command of this.pending.values()) {
      if (unconsumed <= MAX_UNCONSUMED_COMPLETIONS) return;
      if (command.completion === null || command.waiter !== null) continue;
      this.pending.delete(command.tag);
      unconsumed -= 1;
    }
  }

  private dispatchUntagged(line: string): void {
    for (const entry of [...this.untaggedWaiters]) {
      if (!entry.matches(line)) continue;
      this.untaggedWaiters.delete(entry);
      entry.waiter.resolve(line);
    }
    for (const listener of [...this.untaggedListeners]) {
      try {
        listener(line);
      } catch {
        // A subscriber that throws must not take the connection's reader with
        // it; the next line is still delivered to everybody else.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Failure
  // -------------------------------------------------------------------------

  /** The socket failed or closed. Every wait, present and future, ends here. */
  private fail(commandError: Error, readError: Error): void {
    if (this.failure !== null) return;
    this.failure = readError;
    this.rejectAll(commandError, readError);
  }

  /**
   * The byte stream can no longer be parsed — an oversized literal means we do
   * not know where the payload ends, so nothing after it can be trusted to be
   * a response. The connection ends with it.
   */
  private failStream(error: Error): void {
    if (this.failure !== null) return;
    this.failure = error;
    this.buffer = '';
    this.rejectAll(error, error);
    this.closeSocket();
  }

  private rejectAll(commandError: Error, readError: Error): void {
    for (const command of [...this.pending.values()]) {
      const waiter = command.waiter;
      const continuation = command.continuationWaiter;
      command.waiter = null;
      command.continuationWaiter = null;
      this.pending.delete(command.tag);
      continuation?.reject(commandError);
      waiter?.reject(commandError);
    }
    const greeting = this.greetingWaiter;
    this.greetingWaiter = null;
    greeting?.reject(readError);
    for (const entry of [...this.untaggedWaiters]) {
      this.untaggedWaiters.delete(entry);
      entry.waiter.reject(readError);
    }
  }

  // -------------------------------------------------------------------------
  // Waiting
  // -------------------------------------------------------------------------

  private wait<T>(
    options: ImapReadOptions,
    timeoutMessage: string,
    attach: (waiter: Waiter<T>) => void,
    detach: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.failure !== null) {
        reject(this.failure);
        return;
      }
      const signal = options.signal;
      if (signal?.aborted === true) {
        reject(new Error('IMAP read cancelled'));
        return;
      }

      const deadline = options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
        detach();
      };
      function onAbort(): void {
        waiter.reject(new Error('IMAP read cancelled'));
      }
      const waiter: Waiter<T> = {
        resolve: (value: T): void => {
          if (settled) return;
          finish();
          resolve(value);
        },
        reject: (error: Error): void => {
          if (settled) return;
          finish();
          reject(error);
        },
      };

      attach(waiter);
      if (deadline !== null && deadline !== undefined) {
        timer = setTimeout(() => { waiter.reject(new Error(timeoutMessage)); }, deadline);
      }
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // -------------------------------------------------------------------------
  // Public wire operations
  // -------------------------------------------------------------------------

  /**
   * Read the server greeting and return it verbatim.
   *
   * The line itself is the answer to more than "is it there": most servers
   * advertise their capabilities inside it, as `* OK [CAPABILITY ...]`, so
   * discarding it would mean asking again for something already said.
   * Resolves immediately when the greeting already arrived.
   */
  async readGreeting(): Promise<string> {
    if (this.greetingSeen) return this.greetingLine;
    return this.wait<string>(
      {},
      'IMAP read timeout',
      (waiter) => { this.greetingWaiter = waiter; },
      () => { this.greetingWaiter = null; },
    );
  }

  /** Send a tagged IMAP command and collect all response lines through completion. */
  async command(text: string): Promise<string[]> {
    const tag = await this.sendCommand(text);
    return this.awaitTag(tag);
  }

  /**
   * Send a tagged command and hand back its tag without waiting.
   *
   * Response lines are collected from the moment the tag is allocated, so a
   * server that answers before the caller gets round to `awaitTag` loses
   * nothing. A command that will stay in flight for a long time and read the
   * stream through `onUntagged` passes `retainUntagged: false`, so its line
   * array does not grow for the length of the round.
   */
  async sendCommand(text: string, options: ImapSendOptions = {}): Promise<string> {
    this.greetingSeen = true;
    const tag = this.nextTag();
    this.pending.set(tag, {
      tag,
      lines: [],
      retainUntagged: options.retainUntagged ?? true,
      completion: null,
      completionLine: '',
      continuations: 0,
      waiter: null,
      continuationWaiter: null,
    });
    try {
      await this.write(`${tag} ${text}${CRLF}`);
    } catch (error) {
      this.pending.delete(tag);
      throw error;
    }
    return tag;
  }

  /**
   * Write one bare line, terminated with CRLF, that is not a tagged command.
   *
   * IDLE's `DONE` is the reason this exists: it answers the server's
   * continuation request and carries no tag of its own, and the tagged
   * completion that follows belongs to the `IDLE` command issued earlier.
   */
  async sendRawLine(text: string): Promise<void> {
    await this.write(`${text}${CRLF}`);
  }

  /**
   * Await the tagged completion of a command issued earlier under `tag`.
   *
   * `NO` and `BAD` reject with the server's own wording, exactly as `command()`
   * does. Pass `timeoutMs: null` with a `signal` for a wait that may last as
   * long as the caller's own bound allows.
   */
  async awaitTag(tag: string, options: ImapReadOptions = {}): Promise<string[]> {
    const command = this.pending.get(tag);
    if (command === undefined) {
      throw new Error(
        `IMAP tag ${tag} was never issued on this connection, or its response ` +
        `has already been collected.`,
      );
    }
    if (command.completion !== null) {
      this.pending.delete(tag);
      if (command.completion === 'OK') return [...command.lines];
      throw new Error(`IMAP command failed: ${command.completionLine}`);
    }
    return this.wait<string[]>(
      options,
      `IMAP command ${tag} timed out`,
      (waiter) => { command.waiter = waiter; },
      () => { command.waiter = null; },
    );
  }

  /**
   * Wait for the `+ ...` continuation request for a command in flight.
   *
   * A tagged completion arriving instead is the server refusing, and is
   * reported as the same plain-language failure a normal command would raise.
   */
  async awaitContinuation(tag: string, options: ImapReadOptions = {}): Promise<void> {
    const command = this.pending.get(tag);
    if (command === undefined) {
      throw new Error(`IMAP tag ${tag} is not in flight on this connection.`);
    }
    if (command.continuations > 0) {
      command.continuations -= 1;
      return;
    }
    if (command.completion !== null) {
      throw new Error(`IMAP command failed: ${command.completionLine}`);
    }
    return this.wait<void>(
      options,
      'IMAP read timeout',
      (waiter) => { command.continuationWaiter = waiter; },
      () => { command.continuationWaiter = null; },
    );
  }

  /**
   * Wait for the first untagged line the predicate accepts.
   *
   * The long-read path: `timeoutMs: null` gives a wait with no deadline at
   * all, ended by the line arriving, by the socket failing, or by `signal`.
   */
  async waitForUntagged(
    matches: (line: string) => boolean,
    options: ImapReadOptions = {},
  ): Promise<string> {
    let entry: UntaggedWaiter | null = null;
    return this.wait<string>(
      options,
      'IMAP read timeout',
      (waiter) => {
        entry = { matches, waiter };
        this.untaggedWaiters.add(entry);
      },
      () => {
        if (entry !== null) this.untaggedWaiters.delete(entry);
      },
    );
  }

  /** Subscribe to untagged responses for as long as the connection lives. */
  onUntagged(listener: ImapUntaggedListener): () => void {
    this.untaggedListeners.add(listener);
    return () => { this.untaggedListeners.delete(listener); };
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
    const byteLength = Buffer.byteLength(payload, 'utf8');
    const tag = await this.sendCommand(`${commandPrefix} {${byteLength}}`);
    await this.awaitContinuation(tag);
    await this.write(`${payload}${CRLF}`);
    return this.awaitTag(tag);
  }

  private nextTag(): string {
    this.tagCounter += 1;
    return `A${String(this.tagCounter).padStart(4, '0')}`;
  }

  private write(data: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket.write(data, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private closeSocket(): void {
    try {
      this.socket.destroy();
    } catch {
      // ignore
    }
  }

  /** Release the socket and end every wait still outstanding. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onSocketError);
    this.socket.off('close', this.onSocketClose);
    this.fail(
      new Error('IMAP connection closed during command'),
      new Error('IMAP connection closed unexpectedly'),
    );
    this.untaggedListeners.clear();
    this.closeSocket();
  }
}
