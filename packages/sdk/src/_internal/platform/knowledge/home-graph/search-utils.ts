export function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

export function isSingularObjectQuery(query: string, tokens: readonly string[]): boolean {
  const normalized = query.toLowerCase();
  if (/\b(the|this|that|my)\s+(tv|television|device|sensor|switch|camera|printer|router|phone)\b/.test(normalized)) return true;
  if (tokens.includes('tv') || tokens.includes('television')) {
    return !tokens.includes('tvs') && !tokens.includes('televisions');
  }
  return false;
}
