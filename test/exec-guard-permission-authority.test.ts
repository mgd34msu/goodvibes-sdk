/**
 * Exec guard — permission-settings authority pins.
 *
 * Background (2026-07-07): the baseline exec guard hard-denied every
 * destructive/escalation-CLASS command (kill, docker, sudo, rm on project
 * paths) regardless of the user's permission settings, so a session with
 * exec set to allow could not kill a process or run docker. These tests pin
 * the corrected contract:
 *
 *   1. Class-level risk is the PERMISSION LAYER's decision. The exec runtime
 *      passes ALL_COMMAND_CLASSES, so a permission-approved command is never
 *      re-denied by class here.
 *   2. The only unconditional denial is the FROZEN catastrophic list
 *      (catastrophicReason in the classifier): root deletion, raw disk
 *      destruction, filesystem wipes, fork bombs. That list must not grow
 *      without an explicit owner ruling.
 *   3. Callers that pass a narrow allowedClasses set (default
 *      DEFAULT_ALLOWED_CLASSES) still get class gating — the parameter is
 *      honored in baseline mode, not just AST mode.
 */
import { describe, expect, test } from 'bun:test';
import { guardExecCommand } from '../packages/sdk/src/platform/tools/exec/ast-guard.js';
import {
  ALL_COMMAND_CLASSES,
  DEFAULT_ALLOWED_CLASSES,
} from '../packages/sdk/src/platform/runtime/permissions/normalization/index.js';

const flags = (enabledIds: readonly string[]) => ({
  isEnabled(id: string): boolean {
    return enabledIds.includes(id);
  },
});

describe('exec guard — permission settings are the authority for command classes', () => {
  test('kill is allowed when the caller (permission layer) permits all classes', async () => {
    const result = await guardExecCommand('kill -TERM 12345', ALL_COMMAND_CLASSES);
    expect(result.allowed).toBe(true);
  });

  test('compound process-management commands are allowed (the bench-session regression)', async () => {
    const result = await guardExecCommand(
      'kill -TERM 147498 2>/dev/null || true; sleep 1; ps -p 147498 -o pid,stat,comm,args 2>/dev/null || true',
      ALL_COMMAND_CLASSES,
    );
    expect(result.allowed).toBe(true);
  });

  test('docker commands are allowed when all classes are permitted', async () => {
    expect((await guardExecCommand('docker ps', ALL_COMMAND_CLASSES)).allowed).toBe(true);
    expect((await guardExecCommand('docker compose up -d', ALL_COMMAND_CLASSES)).allowed).toBe(true);
  });

  test('sudo and rm on real paths defer to the permission layer', async () => {
    expect((await guardExecCommand('sudo systemctl restart myservice', ALL_COMMAND_CLASSES)).allowed).toBe(true);
    expect((await guardExecCommand('rm -rf /tmp/scratch-dir', ALL_COMMAND_CLASSES)).allowed).toBe(true);
  });

  test('a narrow allowedClasses set is honored in baseline mode (not only AST mode)', async () => {
    const result = await guardExecCommand('kill -TERM 12345', DEFAULT_ALLOWED_CLASSES);
    expect(result.allowed).toBe(false);
    expect(result.denialMessage).toContain('destructive');
  });
});

describe('exec guard — the frozen catastrophic list is unconditional', () => {
  test('rm -rf / is denied even with every class permitted', async () => {
    const result = await guardExecCommand('rm -rf /', ALL_COMMAND_CLASSES);
    expect(result.allowed).toBe(false);
    expect(result.denialMessage).toContain('destructive');
    expect(result.denialMessage).toContain('not affected by permission settings');
  });

  test('catastrophic segments are caught inside compound commands', async () => {
    const result = await guardExecCommand('echo hello | rm -rf /', ALL_COMMAND_CLASSES);
    expect(result.allowed).toBe(false);
    expect(result.denialMessage).toContain('destructive');
  });

  test('raw disk writes are denied; ordinary dd between files is not', async () => {
    expect((await guardExecCommand('dd if=/dev/zero of=/dev/sda', ALL_COMMAND_CLASSES)).allowed).toBe(false);
    expect((await guardExecCommand('dd if=disk.img of=backup.img bs=4M', ALL_COMMAND_CLASSES)).allowed).toBe(true);
  });

  test('filesystem wipes and fork bombs are denied', async () => {
    expect((await guardExecCommand('mkfs.ext4 /dev/sdb1', ALL_COMMAND_CLASSES)).allowed).toBe(false);
    expect((await guardExecCommand(':(){ :|:&};:', ALL_COMMAND_CLASSES)).allowed).toBe(false);
  });
});

describe('exec guard — AST mode keeps the same authority split', () => {
  test('kill is allowed in AST mode with all classes permitted', async () => {
    const result = await guardExecCommand(
      'kill -TERM 12345',
      ALL_COMMAND_CLASSES,
      flags(['shell-ast-normalization']),
    );
    expect(result.astModeActive).toBe(true);
    expect(result.allowed).toBe(true);
  });

  test('rm -rf / stays denied in AST mode regardless of allowed classes', async () => {
    const result = await guardExecCommand(
      'rm -rf /',
      ALL_COMMAND_CLASSES,
      flags(['shell-ast-normalization']),
    );
    expect(result.astModeActive).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.denialMessage).toContain('destructive');
  });
});
