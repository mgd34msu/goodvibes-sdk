import type { CompanionConnectionInfo } from './companion-token.js';

const DIVIDER = '\u2501'.repeat(24); // ━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Format a human-readable connection block for stdout display in daemon standalone mode.
 *
 * @param info - The companion connection info.
 * @param qrString - The rendered QR code string (from renderQrToString).
 * @returns Formatted multi-line string ready for stdout.
 */
export function formatConnectionBlock(
  info: CompanionConnectionInfo,
  qrString: string,
): string {
  const header = `goodvibes daemon v${info.version}`;
  const urlLine = `URL:    ${info.url}`;
  const tokenLine = `Token:  ${info.token}`;
  const userLine = `User:   ${info.username}`;

  return [
    header,
    DIVIDER,
    urlLine,
    tokenLine,
    userLine,
    '',
    'Scan to connect:',
    '',
    qrString,
    '',
    'Waiting for connections...',
  ].join('\n');
}
