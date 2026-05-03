import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCAN_ROOT = resolve(ROOT, 'packages/sdk/src/platform');
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['dist', 'node_modules']);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...walk(join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

function stripStrings(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function scanFile(file: string): Finding[] {
  const findings: Finding[] = [];
  let blockComment = false;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index] ?? '';
    if (blockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      blockComment = false;
    }
    while (line.includes('/*')) {
      const start = line.indexOf('/*');
      const end = line.indexOf('*/', start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        blockComment = true;
        break;
      }
      line = `${line.slice(0, start)} ${line.slice(end + 2)}`;
    }
    const withoutLineComment = line.split('//')[0] ?? '';
    if (/\bconsole\.(?:log|warn|error|info|debug)\s*\(/.test(stripStrings(withoutLineComment))) {
      findings.push({
        file: relative(ROOT, file).replace(/\\/g, '/'),
        line: index + 1,
        text: lines[index]?.trim() ?? '',
      });
    }
  }
  return findings;
}

const findings = walk(SCAN_ROOT).flatMap(scanFile);
if (findings.length === 0) {
  console.log('platform-console-check: OK - no executable console.* calls in packages/sdk/src/platform.');
  process.exit(0);
}

console.error('platform-console-check: FAIL - use the platform logger instead of console.* in SDK platform code.');
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}: ${finding.text}`);
}
process.exit(1);
