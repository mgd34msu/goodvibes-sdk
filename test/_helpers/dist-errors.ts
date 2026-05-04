/**
 * Error-class re-exports from the COMPILED dist bundle.
 *
 * WHY NOT SOURCE: `instanceof` checks inside transport-http/dist/ use the
 * error constructors from `packages/errors/dist/index.js`. If a test imports
 * from `packages/errors/src/index.ts`, those are a separate module instance
 * and `instanceof` returns false across the boundary.
 *
 * For tests that assert `err instanceof GoodVibesSdkError`, use these re-exports.
 *
 * CRIT-01 (eighth-review): Wire the dist-staleness sentinel so dist-loading tests
 * fail loudly when the compiled output is older than the TypeScript source.
 */
import './dist-mtime-check.js';
export {
  GoodVibesSdkError,
  HttpStatusError,
  ConfigurationError,
  ContractError,
} from '../../packages/errors/dist/index.js';
