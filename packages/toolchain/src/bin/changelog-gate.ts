#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { consoleLogger } from '../lib/effects.js';
import { runChangelogGate, type ChangelogHeading } from '../lib/changelog-gate.js';

const root = process.cwd();
const versionArg = process.argv.find((a) => /^\d+\.\d+\.\d+/.test(a));
const version = versionArg ?? (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
const headingArg = process.argv.includes('--plain') ? 'plain' : process.argv.includes('--bracket') ? 'bracket' : 'either';
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const result = runChangelogGate(changelog, version, headingArg as ChangelogHeading);
consoleLogger.info(`changelog-gate: ${result.detail}`);
process.exit(result.ok ? 0 : 1);
