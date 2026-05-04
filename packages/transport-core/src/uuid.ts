import { GoodVibesSdkError } from '@pellux/goodvibes-errors';

export function createUuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    throw new GoodVibesSdkError('Secure random UUID generation is unavailable in this runtime.', {
      category: 'config',
      source: 'transport',
      recoverable: false,
      hint: 'Run GoodVibes in a runtime with crypto.randomUUID() or crypto.getRandomValues().',
    });
  }
  bytes[6]! = (bytes[6]! & 0x0f) | 0x40;
  bytes[8]! = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
