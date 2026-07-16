#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { realHttpGetJson, realSleep, consoleLogger } from '../lib/effects.js';
import { verifyPerJobGreen } from '../lib/per-job-green.js';
import { resolvePerJobGreenConfig } from '../config.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const repoSlug = argValue('--repo') ?? process.env.GITHUB_REPOSITORY ?? '';
const [owner, repo] = repoSlug.split('/');
const sha = argValue('--sha') ?? process.env.GITHUB_SHA;
if (!owner || !repo || !sha) {
  consoleLogger.error('per-job-green: --repo <owner/repo> (or GITHUB_REPOSITORY) and --sha (or GITHUB_SHA) are required');
  process.exit(2);
}

const config = resolvePerJobGreenConfig({
  owner,
  repo,
  workflow: argValue('--workflow') ?? 'ci.yml',
  event: argValue('--event') ?? 'push',
});

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const result = await verifyPerJobGreen(
  { http: realHttpGetJson, sleep: realSleep, logger: consoleLogger, now: () => Date.now(), ...(token ? { token } : {}) },
  config,
  sha,
);

consoleLogger.info(`per-job-green: ${result.reason}`);
if (result.failures.length > 0) consoleLogger.info(`  non-green: ${result.failures.join(', ')}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${result.runId ?? ''}\nhead_sha=${result.headSha ?? ''}\nok=${result.ok}\n`);
}
process.exit(result.ok ? 0 : 1);
