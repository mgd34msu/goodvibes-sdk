/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import type { BackgroundProcess } from '../../../tools/shared/process-manager.js';
import type { ProcessNode, ProcessState } from '../types.js';

/** Last non-empty stdout line — already tracked on the record, no new emission needed. */
export function lastOutputLine(stdout: readonly string[]): string | undefined {
  // stdout is an array of chunks; join a bounded tail and take the last
  // non-empty line so the scan stays cheap even for chatty processes.
  const tail = stdout.slice(-8).join('');
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) return line;
  }
  return undefined;
}

/**
 * BackgroundProcess → ProcessNode. Silent source (no bus emission): liveness
 * rides the registry tick; currentActivity is the last stdout line the
 * ProcessManager already buffers.
 */
export function adaptBackgroundProcess(record: BackgroundProcess, now: number): ProcessNode {
  let state: ProcessState;
  if (!record.done) state = 'executing-tool';
  else if (record.exitCode !== null && record.exitCode !== 0) state = 'failed';
  else state = 'done';
  const line = lastOutputLine(record.stdout);
  return {
    id: record.id,
    kind: 'background-process',
    parentId: undefined,
    label: record.cmd,
    state,
    startedAt: record.startTime,
    completedAt: record.completedAt,
    elapsedMs: Math.max(0, (record.completedAt ?? now) - record.startTime),
    costUsd: null,
    costState: 'unpriced',
    // Silent source: anchored to a stable timestamp (chunk arrival times are
    // not tracked), so an unchanged line never looks like fresh activity.
    currentActivity: line ? { kind: 'output-line', text: line, at: record.completedAt ?? record.startTime } : undefined,
    capabilities: { interruptible: false, killable: !record.done, pausable: false },
    raw: record,
  };
}
