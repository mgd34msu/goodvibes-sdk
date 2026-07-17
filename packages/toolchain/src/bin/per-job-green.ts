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

function intArg(flag: string): number | undefined {
  const raw = argValue(flag);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    consoleLogger.error(`per-job-green: ${flag} must be a positive integer (got '${raw}')`);
    process.exit(2);
  }
  return value;
}

const retryAttempts = intArg('--retry-attempts');
const retryDelayMs = intArg('--retry-delay-ms');
// Size --deadline-ms UNDER the enclosing CI job's timeout cap so an exhausted
// wait produces the tool's honest named verdict (deadline-exceeded) instead of
// a raw job kill with no verdict at all.
const deadlineMs = intArg('--deadline-ms');
const config = resolvePerJobGreenConfig({
  owner,
  repo,
  workflow: argValue('--workflow') ?? 'ci.yml',
  event: argValue('--event') ?? 'push',
  ...(retryAttempts !== undefined ? { retryAttempts } : {}),
  ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
  ...(deadlineMs !== undefined ? { deadlineMs } : {}),
});

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const result = await verifyPerJobGreen(
  { http: realHttpGetJson, sleep: realSleep, logger: consoleLogger, now: () => Date.now(), ...(token ? { token } : {}) },
  config,
  sha,
);

consoleLogger.info(`per-job-green: ${result.reason}`);
if (result.failures.length > 0) consoleLogger.info(`  non-green: ${result.failures.join(', ')}`);
if (result.ok && result.runId === null) {
  consoleLogger.warn('per-job-green: verdict is green but the run id is UNRESOLVED — run_id output is empty; artifact restores keyed on it must fail fast rather than download from the wrong run');
}

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${result.runId ?? ''}\nhead_sha=${result.headSha ?? ''}\nok=${result.ok}\n`);
}
process.exit(result.ok ? 0 : 1);
