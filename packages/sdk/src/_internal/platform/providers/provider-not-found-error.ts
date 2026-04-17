/**
 * Thrown by {@link ProviderRegistry.require} when no provider with the given ID
 * is registered.
 *
 * The error message includes the list of all currently-registered provider IDs
 * so callers can quickly see what is available without having to inspect the
 * registry separately.
 */
export class ProviderNotFoundError extends Error {
  /** The provider ID that was requested. */
  readonly providerId: string;
  /** Sorted list of currently-registered provider IDs at the time of the error. */
  readonly availableIds: readonly string[];

  constructor(providerId: string, available: readonly string[]) {
    const ids = available.length > 0 ? available.join(', ') : '(none)';
    super(
      `Provider '${providerId}' is not registered. ` +
      `Available providers: ${ids}`,
    );
    this.name = 'ProviderNotFoundError';
    this.providerId = providerId;
    this.availableIds = available;
    // Maintains proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
