/**
 * Error-class re-exports from the COMPILED dist bundle.
 *
 * WHY NOT SOURCE: `instanceof` checks inside transport-http/dist/ use the
 * error constructors from `packages/errors/dist/index.js`. If a test imports
 * from `packages/errors/src/index.ts`, those are a separate module instance
 * and `instanceof` returns false across the boundary.
 *
 * For tests that assert `err instanceof GoodVibesSdkError`, use these re-exports.
 */
export {
  GoodVibesSdkError,
  HttpStatusError,
  ConfigurationError,
  ContractError,
} from '../../packages/errors/dist/index.js';
