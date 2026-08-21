/**
 * The machine half of the email service.
 *
 * Everything else in this module is protocol and policy over an injected
 * socket, so the IMAP client, the SMTP client and the whole service run in a
 * test against an in-process fake server with no TLS and no real host. That
 * property is only worth anything if the connecting code lives somewhere
 * separate, and this is that somewhere: three socket factories, each the ONLY
 * place a real connection is opened.
 *
 *   - `createImapTlsSocket`      IMAP over implicit TLS (port 993)
 *   - `createImapPlainSocket`    IMAP unencrypted (port 143), for a localhost or
 *                                test server, `surfaces.email.imap.secure: false`
 *   - `createSmtpTlsSocket`      SMTP submission over implicit TLS (port 465)
 *   - `createSmtpStartTlsSocket` SMTP submission, plain then STARTTLS (port 587)
 *
 * `nodeEmailTransport` bundles them into the `EmailTransportPort` the service
 * asks for.
 *
 * This entry is deliberately NOT re-exported from the module index: importing
 * the email service must never drag `node:tls` in behind it. A consumer asks
 * for these by name, from here.
 */

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';
import { IMAP_DEFAULT_TIMEOUT_MS } from './imap-client.js';
import { SMTP_DEFAULT_TIMEOUT_MS } from './smtp-client.js';
import type { EmailTransportPort } from './email-service.js';

const CRLF = '\r\n';

// ---------------------------------------------------------------------------
// Socket factories (production)
// ---------------------------------------------------------------------------

/**
 * Creates a TLS socket connected to an IMAP server on port 993 (or custom).
 * Returns a connected Socket ready to pass to ImapClient.
 */
export function createImapTlsSocket(
  host: string,
  port: number,
  timeoutMs: number = IMAP_DEFAULT_TIMEOUT_MS,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`IMAP TLS connect timeout to ${host}:${port}`));
    }, timeoutMs);

    const sock = tlsConnect({ host, port, servername: host }, () => {
      clearTimeout(timer);
      resolve(sock as unknown as Socket);
    });

    sock.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Creates a PLAIN socket connected to an IMAP server (port 143 by convention).
 *
 * Reached only when `surfaces.email.imap.secure` is false. Nothing here is
 * encrypted, which is the point: an IMAP server on localhost, or a fake in an
 * acceptance run, offers no TLS to negotiate, and every hosted provider is
 * served by `createImapTlsSocket` above.
 */
export function createImapPlainSocket(
  host: string,
  port: number,
  timeoutMs: number = IMAP_DEFAULT_TIMEOUT_MS,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`IMAP connect timeout to ${host}:${port}`));
    }, timeoutMs);

    const sock = netConnect({ host, port }, () => {
      clearTimeout(timer);
      resolve(sock);
    });

    sock.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Connect TLS-direct (implicit TLS, port 465). */
export function createSmtpTlsSocket(
  host: string,
  port: number,
  timeoutMs: number = SMTP_DEFAULT_TIMEOUT_MS,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`SMTP TLS connect timeout to ${host}:${port}`));
    }, timeoutMs);

    const sock = tlsConnect({ host, port, servername: host }, () => {
      clearTimeout(timer);
      resolve(sock as unknown as Socket);
    });

    sock.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Connect plain then upgrade via STARTTLS (port 587). */
export function createSmtpStartTlsSocket(
  host: string,
  port: number,
  timeoutMs: number = SMTP_DEFAULT_TIMEOUT_MS,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      plain.destroy();
      reject(new Error(`SMTP STARTTLS connect timeout to ${host}:${port}`));
    }, timeoutMs);

    const plain = netConnect({ host, port }, () => {
      // Read the 220 greeting, send EHLO, then STARTTLS
      let buffer = '';
      plain.setEncoding('utf8');

      const onGreeting = (chunk: string): void => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        plain.off('data', onGreeting);

        plain.write(`EHLO ${host}${CRLF}`, 'utf8', () => {
          let ehloBuffer = '';
          const onEhlo = (data: string): void => {
            ehloBuffer += data;
            // Wait for final 250 line (no dash)
            if (!/^250 /m.test(ehloBuffer)) return;
            plain.off('data', onEhlo);

            plain.write(`STARTTLS${CRLF}`, 'utf8', () => {
              let stBuffer = '';
              const onStartTls = (data: string): void => {
                stBuffer += data;
                if (!stBuffer.includes('\n')) return;
                plain.off('data', onStartTls);

                if (!stBuffer.startsWith('220')) {
                  clearTimeout(timer);
                  plain.destroy();
                  reject(new Error(`STARTTLS rejected: ${stBuffer.trim()}`));
                  return;
                }

                // STARTTLS guard: assert no pipelined data arrived after the 220 reply.
                // Any bytes beyond the \n of the 220 line indicate a hostile server
                // injecting data before TLS negotiation begins.
                const newlineIdx = stBuffer.indexOf('\n');
                const afterNewline = newlineIdx !== -1 ? stBuffer.slice(newlineIdx + 1) : '';
                if (afterNewline.length > 0) {
                  clearTimeout(timer);
                  plain.destroy();
                  reject(new Error(
                    'STARTTLS aborted: server sent data after the 220 response before TLS upgrade. ' +
                    'This may indicate a STARTTLS injection attack.',
                  ));
                  return;
                }

                const upgraded = tlsConnect({
                  socket: plain,
                  host,
                  servername: host,
                }, () => {
                  clearTimeout(timer);
                  resolve(upgraded as unknown as Socket);
                });
                upgraded.once('error', (err: Error) => {
                  clearTimeout(timer);
                  reject(err);
                });
              };
              plain.on('data', onStartTls);
            });
          };
          plain.on('data', onEhlo);
        });
      };

      plain.on('data', onGreeting);
    });

    plain.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// The transport port
// ---------------------------------------------------------------------------

/**
 * The real transports, as the `EmailTransportPort` the service asks for.
 *
 * Hand this to `new EmailService({ transport: nodeEmailTransport, ... })` in
 * production. A test hands over one whose members throw, which is how a test
 * proves it never reached for a real host.
 */
export const nodeEmailTransport: EmailTransportPort = {
  connectImapTls: (host, port) => createImapTlsSocket(host, port),
  connectImapPlain: (host, port) => createImapPlainSocket(host, port),
  connectSmtpTls: (host, port) => createSmtpTlsSocket(host, port),
  connectSmtpStartTls: (host, port) => createSmtpStartTlsSocket(host, port),
};
