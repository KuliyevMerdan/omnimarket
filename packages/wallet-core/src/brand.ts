/**
 * Cross-bundle `instanceof`. In a micro-frontend setup the host and a remote can each end up with
 * their own copy of this package (a misconfigured share, a version mismatch), and then
 * `connector instanceof SolanaConnector` is false for a connector the other copy created.
 * `Symbol.for` keys live in the realm-wide registry, so a brand set by one copy is seen by every copy;
 * classes route `instanceof` to it through `Symbol.hasInstance`, and call sites stay unchanged.
 */
export function hasBrand(value: unknown, brand: symbol): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true
}
