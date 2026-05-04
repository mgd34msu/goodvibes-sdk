import { createServer } from 'node:net';

/**
 * Allocate an OS-assigned ephemeral port by binding on :0 and returning
 * the assigned port number. The server is closed before returning so the
 * port is free for the test to use.
 *
 * NOTE: There is a TOCTOU window between close() and the test listener
 * binding. In practice this is not a problem for sequential bun:test runs.
 * For tests that only build mock URLs (never bind a real socket), continue
 * to use a hardcoded port — this helper is only needed for real listeners.
 *
 * Example:
 * ```ts
 * import { ephemeralPort } from './_helpers/port.js';
 *
 * const port = await ephemeralPort();
 * const server = Bun.serve({ port, fetch: handler });
 * // ... test ...
 * server.stop();
 * ```
 */
export async function ephemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Could not determine ephemeral port')));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
