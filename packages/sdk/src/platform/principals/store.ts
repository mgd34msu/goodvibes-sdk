/**
 * principals/store.ts
 *
 * Durable JSON-snapshot persistence for the principal registry, following the
 * exact PersistentStore snapshot pattern the automation stores use
 * (automation/store/jobs.ts): a versioned document, atomic write, and a
 * validate step that treats a missing file as an empty registry but a corrupt
 * document as a loud error.
 */
import { PersistentStore } from '../state/persistent-store.js';
import type { PrincipalRecord } from './types.js';

interface PrincipalsSnapshot extends Record<string, unknown> {
  version: 1;
  principals: PrincipalRecord[];
}

function defaultSnapshot(): PrincipalsSnapshot {
  return { version: 1, principals: [] };
}

function validateSnapshot(snapshot: PrincipalsSnapshot | null): PrincipalsSnapshot {
  if (!snapshot) return defaultSnapshot();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.principals)) {
    throw new Error('Principal registry store snapshot is invalid.');
  }
  return { version: 1, principals: snapshot.principals };
}

export class PrincipalStore {
  private readonly store: PersistentStore<PrincipalsSnapshot>;

  constructor(path: string) {
    this.store = new PersistentStore<PrincipalsSnapshot>(path);
  }

  async load(): Promise<PrincipalRecord[]> {
    return validateSnapshot(await this.store.load()).principals;
  }

  async save(principals: readonly PrincipalRecord[]): Promise<void> {
    await this.store.persist({ version: 1, principals: [...principals] });
  }
}
