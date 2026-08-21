// api-extractor emits CRLF when it rewrites a report; the repo's attributes
// declare LF. Normalizing here keeps api:check's git-diff gate meaningful
// instead of failing on line endings after every version bump.
import { readFileSync, writeFileSync } from 'node:fs';
for (const file of [
  'etc/goodvibes-sdk.api.md',
  'etc/goodvibes-sdk-embed.api.md',
  'etc/goodvibes-terminal-shell.api.md',
]) {
  const text = readFileSync(file, 'utf8');
  const normalized = text.replaceAll('\r\n', '\n');
  if (normalized !== text) writeFileSync(file, normalized);
}
