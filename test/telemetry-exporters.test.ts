import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleExporter } from '../packages/sdk/src/platform/runtime/telemetry/exporters/console.js';
import { LocalLedgerExporter } from '../packages/sdk/src/platform/runtime/telemetry/exporters/local-ledger.js';
import type { ReadableSpan } from '../packages/sdk/src/platform/runtime/telemetry/types.js';
import { SpanKind, SpanStatusCode } from '../packages/sdk/src/platform/runtime/telemetry/types.js';
import { logger } from '../packages/sdk/src/platform/utils/logger.js';

type LoggerWarn = typeof logger.warn;

const originalLoggerWarn = logger.warn;
const stderr = process.stderr as unknown as { write: (...args: unknown[]) => boolean };
const originalStderrWrite = stderr.write;
const tempDirs: string[] = [];

afterEach(() => {
  logger.warn = originalLoggerWarn;
  stderr.write = originalStderrWrite;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('telemetry exporters', () => {
  test('console exporter logs stderr write failures', async () => {
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    logger.warn = ((message, data) => {
      warnings.push({ message, data });
    }) as LoggerWarn;
    stderr.write = () => {
      throw new Error('stderr unavailable');
    };

    await new ConsoleExporter().export([makeSpan()]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('[ConsoleExporter] stderr write failed');
    expect(warnings[0]?.data).toMatchObject({
      spanName: 'test.span',
      traceId: '11111111111111111111111111111111',
      spanId: '2222222222222222',
    });
  });

  test('local ledger exporter logs file write failures', async () => {
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    logger.warn = ((message, data) => {
      warnings.push({ message, data });
    }) as LoggerWarn;
    const dir = makeTempDir();

    await new LocalLedgerExporter({ filePath: dir }).export([makeSpan()]);

    expect(warnings.some((entry) => entry.message === '[local-ledger] export failed')).toBe(true);
    expect(warnings.find((entry) => entry.message === '[local-ledger] export failed')?.data).toMatchObject({
      filePath: dir,
      spanCount: 1,
      writtenSpans: 1,
      droppedSpans: 0,
    });
  });

  test('local ledger exporter logs serialization drops', async () => {
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    logger.warn = ((message, data) => {
      warnings.push({ message, data });
    }) as LoggerWarn;
    const dir = makeTempDir();
    const filePath = join(dir, 'spans.jsonl');
    const circularAttributes: Record<string, unknown> = {};
    circularAttributes.self = circularAttributes;

    await new LocalLedgerExporter({ filePath }).export([
      makeSpan({ attributes: circularAttributes as ReadableSpan['attributes'] }),
    ]);

    expect(warnings.map((entry) => entry.message)).toContain('[local-ledger] span serialization failed');
    expect(warnings.map((entry) => entry.message)).toContain('[local-ledger] export produced no serializable spans');
    expect(existsSync(filePath)).toBe(false);
  });

  test('local ledger event recorder logs ledger write failures', () => {
    const warnings: Array<{ message: string; data?: Record<string, unknown> }> = [];
    logger.warn = ((message, data) => {
      warnings.push({ message, data });
    }) as LoggerWarn;
    const dir = makeTempDir();

    new LocalLedgerExporter({ filePath: join(dir, 'spans.jsonl'), ledgerFilePath: dir }).recordEvent({
      runId: 'run-1',
      rev: 1,
      eventName: 'test.event',
      payload: {},
      ts: 1,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('[local-ledger] ledger write failed');
    expect(warnings[0]?.data).toMatchObject({
      ledgerFilePath: dir,
      runId: 'run-1',
      rev: 1,
      eventName: 'test.event',
    });
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-telemetry-exporters-'));
  tempDirs.push(dir);
  return dir;
}

function makeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: 'test.span',
    kind: SpanKind.INTERNAL,
    spanContext: {
      traceId: '11111111111111111111111111111111',
      spanId: '2222222222222222',
      isValid: true,
    },
    startTimeMs: 1,
    endTimeMs: 3,
    durationMs: 2,
    attributes: {},
    events: [],
    status: { code: SpanStatusCode.OK },
    instrumentationScope: 'test',
    ...overrides,
  };
}
