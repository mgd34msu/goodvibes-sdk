import type { ForensicsRegistry } from './forensics/index.js';

export interface UiObservabilityReadModelOptions {
  readonly forensicsRegistry?: ForensicsRegistry | undefined;
}
