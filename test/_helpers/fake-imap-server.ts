/**
 * The in-process fake IMAP server the IMAP tests drive the real client
 * against. No real network connection is made and no TLS is involved: the
 * client takes an injected socket, so a plain `net` pair on 127.0.0.1:0 is a
 * complete server for these purposes.
 *
 * Lifted out of `platform-email-imap.test.ts` unchanged so the session and UID
 * suites drive the same harness rather than a second one that could drift from
 * it.
 */

import { createServer, connect, type Server, type Socket } from 'node:net';

export interface FakeServer {
  readonly address: { port: number };
  readonly server: Server;
  close(): void;
}

export function makeFakeImapServer(
  script: (socket: Socket) => void,
): Promise<FakeServer> {
  return new Promise<FakeServer>((resolve) => {
    const server = createServer((socket) => {
      script(socket);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        address: { port: (addr as { port: number }).port },
        server,
        close: () => server.close(),
      });
    });
  });
}

export function serverWrite(socket: Socket, line: string): void {
  socket.write(`${line}\r\n`);
}

/**
 * Write bytes exactly as given, with no line terminator added.
 *
 * `{n}` literals are the reason this exists: the count is a BYTE count and the
 * payload is not lines, so a helper that appends CRLF would make every literal
 * one or two bytes shorter than it claims and desynchronize the client's
 * reader. Anything emitting a literal writes the announcement, the payload and
 * whatever follows it through here.
 */
export function serverWriteRaw(socket: Socket, bytes: string): void {
  socket.write(bytes);
}

export async function connectSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => resolve(sock));
  });
}
