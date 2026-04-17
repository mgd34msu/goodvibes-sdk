/**
 * Crypto adapter — runtime-neutral interface for PKCE and random-bytes
 * operations used by oauth-core.ts.
 *
 * This file uses the Web Crypto API (globalThis.crypto), which is available
 * in React Native (Hermes / JavaScriptCore), modern browsers, and Node >= 19.
 *
 * API:
 *   createSha256Hash(input: string): Promise<string>  — returns base64url digest
 *   randomBytesBase64url(n: number): string           — returns n random bytes as base64url
 */

/**
 * Compute SHA-256 of `input` and return the result as a base64url string.
 * Uses Web Crypto API — safe in React Native, browser, and modern Node.
 */
export async function createSha256Hash(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  return uint8ArrayToBase64url(new Uint8Array(hashBuffer));
}

/**
 * Generate `n` cryptographically random bytes and return as base64url.
 * Uses Web Crypto API — safe in React Native, browser, and modern Node.
 */
export function randomBytesBase64url(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return uint8ArrayToBase64url(bytes);
}

function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
