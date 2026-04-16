export type {
  QrMatrix,
} from './qr-generator.js';
export {
  generateQrMatrix,
  renderQrToString,
} from './qr-generator.js';

export type {
  CompanionPairingResult,
  CompanionConnectionInfo,
  CompanionTokenRecord,
} from './companion-token.js';
export {
  getOrCreateCompanionToken,
  regenerateCompanionToken,
  buildCompanionConnectionInfo,
  encodeConnectionPayload,
} from './companion-token.js';

export { formatConnectionBlock } from './connection-info.js';
