/**
 * PermissionResolver — Focused responsibility: role and scope checks.
 *
 * Inspects a `ControlPlaneAuthSnapshot` to answer permission questions.
 * Callers that only need access control checks can use this directly
 * rather than traversing the full auth snapshot themselves.
 */

import type { ControlPlaneAuthSnapshot } from '../control-plane/auth-snapshot.js';

export class PermissionResolver {
  readonly #snapshot: ControlPlaneAuthSnapshot;

  constructor(snapshot: ControlPlaneAuthSnapshot) {
    this.#snapshot = snapshot;
  }

  /** Whether the current principal is authenticated. */
  get authenticated(): boolean {
    return this.#snapshot.authenticated;
  }

  /** Whether the current principal has admin privileges. */
  get isAdmin(): boolean {
    return this.#snapshot.admin;
  }

  /** The principal identifier (user/bot/service id), or null when anonymous. */
  get principalId(): string | null {
    return this.#snapshot.principalId;
  }

  /** The kind of the current principal. */
  get principalKind(): ControlPlaneAuthSnapshot['principalKind'] {
    return this.#snapshot.principalKind;
  }

  /** Return true when the principal holds the given role. */
  hasRole(role: string): boolean {
    return this.#snapshot.roles.includes(role);
  }

  /** Return true when the principal holds ALL of the given roles. */
  hasAllRoles(roles: readonly string[]): boolean {
    return roles.every((role) => this.#snapshot.roles.includes(role));
  }

  /** Return true when the principal holds ANY of the given roles. */
  hasAnyRole(roles: readonly string[]): boolean {
    return roles.some((role) => this.#snapshot.roles.includes(role));
  }

  /** Return true when the principal holds the given scope. */
  hasScope(scope: string): boolean {
    return this.#snapshot.scopes.includes(scope);
  }

  /** Return true when the principal holds ALL of the given scopes. */
  hasAllScopes(scopes: readonly string[]): boolean {
    return scopes.every((scope) => this.#snapshot.scopes.includes(scope));
  }

  /** Return true when the principal holds ANY of the given scopes. */
  hasAnyScope(scopes: readonly string[]): boolean {
    return scopes.some((scope) => this.#snapshot.scopes.includes(scope));
  }

  /** Expose the raw snapshot for direct inspection. */
  get snapshot(): ControlPlaneAuthSnapshot {
    return this.#snapshot;
  }
}
