'use strict';

const { randomBytes, randomUUID } = require('crypto');

function stringify(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function v4(options, buf, offset = 0) {
  if (!buf && !options && typeof randomUUID === 'function') {
    return randomUUID();
  }

  const bytes = options?.random ?? options?.rng?.() ?? randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  if (buf) {
    if (offset < 0 || offset + 16 > buf.length) {
      throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
    }

    for (let i = 0; i < 16; i += 1) {
      buf[offset + i] = bytes[i];
    }
    return buf;
  }

  return stringify(bytes);
}

module.exports = { v4 };
