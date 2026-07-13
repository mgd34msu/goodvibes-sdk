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
  pruneStaleOperatorTokens,
} from './companion-token.js';
export type { PruneStaleOperatorTokensOptions, PruneStaleOperatorTokensResult } from './companion-token.js';

export { formatConnectionBlock } from './connection-info.js';

export { PairingTokenManager, pairingPrincipalId } from './pairing-token-store.js';
export type {
  PublicPairingToken,
  MintedPairingToken,
  AuthenticatedPairingToken,
} from './pairing-token-store.js';

export {
  buildPairingHandoffLink,
  buildPairingHandoffFragment,
  parsePairingHandoffLink,
  normalizeOffers,
  PAIRING_HANDOFF_OFFER_KINDS,
  PAIRING_FRAGMENT_KEY,
  PAIRING_OFFERS_FRAGMENT_KEY,
} from './pairing-handoff.js';
export type {
  PairingHandoffOfferKind,
  BuildPairingHandoffLinkInput,
  ParsedPairingHandoff,
} from './pairing-handoff.js';
