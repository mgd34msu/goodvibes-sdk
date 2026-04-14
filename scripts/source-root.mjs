import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SDK_ROOT = resolve(__dirname, '..');

function isCandidateRoot(path) {
  return existsSync(path)
    && existsSync(resolve(path, 'package.json'))
    && existsSync(resolve(path, 'src'))
    && existsSync(resolve(path, 'docs'));
}

export function resolveTuiRoot({ required = false } = {}) {
  const candidates = [];
  if (typeof process.env.GOODVIBES_TUI_ROOT === 'string' && process.env.GOODVIBES_TUI_ROOT.trim()) {
    candidates.push(resolve(process.env.GOODVIBES_TUI_ROOT.trim()));
  }
  candidates.push(resolve(SDK_ROOT, '..', 'goodvibes-tui'));

  for (const candidate of candidates) {
    if (isCandidateRoot(candidate)) {
      return candidate;
    }
  }

  if (required) {
    throw new Error(
      'Unable to locate goodvibes-tui. Set GOODVIBES_TUI_ROOT or place the source repo at ../goodvibes-tui before running source-sync commands.',
    );
  }

  return null;
}
