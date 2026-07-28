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

export async function connectSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => resolve(sock));
  });
}
