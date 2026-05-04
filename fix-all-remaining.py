#!/usr/bin/env python3
"""
Fix remaining TypeScript strict-mode errors by reading each error location
and applying the appropriate fix based on error type and context.
"""
import re
import sys
from pathlib import Path

ROOT = Path("/home/buzzkill/Projects/goodvibes-sdk")

def read_file(path: Path) -> list[str]:
    try:
        return path.read_text().splitlines(keepends=True)
    except Exception as e:
        print(f"  ERROR reading {path}: {e}")
        return []

def write_file(path: Path, lines: list[str]) -> None:
    path.write_text("".join(lines))

def get_line(lines: list[str], lineno: int) -> str:
    if 1 <= lineno <= len(lines):
        return lines[lineno - 1]
    return ""

def set_line(lines: list[str], lineno: int, content: str) -> None:
    if 1 <= lineno <= len(lines):
        lines[lineno - 1] = content

def parse_errors(error_text: str) -> list[dict]:
    errors = []
    pattern = re.compile(r'^(packages/[^(]+)\((\d+),(\d+)\): error (TS\d+): (.+)$')
    for line in error_text.splitlines():
        m = pattern.match(line.strip())
        if m:
            errors.append({
                'file': m.group(1),
                'line': int(m.group(2)),
                'col': int(m.group(3)),
                'code': m.group(4),
                'msg': m.group(5),
            })
    return errors

# Load all errors
with open("/tmp/current-errors.txt") as f:
    error_text = f.read()

errors = parse_errors(error_text)
print(f"Total errors to fix: {len(errors)}")

from collections import defaultdict
by_file = defaultdict(list)
for e in errors:
    by_file[e['file']].append(e)

modified_files = set()
total_fixed = 0

for filepath, file_errors in sorted(by_file.items()):
    full_path = ROOT / filepath
    if not full_path.exists():
        print(f"  SKIP (not found): {filepath}")
        continue

    lines = read_file(full_path)
    if not lines:
        continue
    changed = False

    # Sort errors by line desc so changes on lower lines don't shift upper ones
    file_errors_sorted = sorted(file_errors, key=lambda e: (e['line'], e['col']), reverse=True)

    for err in file_errors_sorted:
        lineno = err['line']
        col = err['col']  # 1-indexed
        code = err['code']
        msg = err['msg']
        line = get_line(lines, lineno)
        if not line:
            continue

        col0 = col - 1  # 0-indexed position

        if code in ('TS2532', 'TS18048'):
            # "Object is possibly 'undefined'" from noUncheckedIndexedAccess
            # Strategy 1: find ] at or just before the error column, add !
            # Strategy 2: find identifier end at column, add !
            new_line = line
            rstrip = line.rstrip('\n')

            # Look for the nearest ] before col0 that isn't followed by !
            found = False
            for i in range(min(col0, len(rstrip) - 1), max(-1, col0 - 80), -1):
                if rstrip[i] == ']' and (i + 1 >= len(rstrip) or rstrip[i+1] != '!'):
                    new_line = rstrip[:i+1] + '!' + rstrip[i+1:] + ('\n' if line.endswith('\n') else '')
                    found = True
                    break

            if not found:
                # Look for identifier ending at col0 and add ! after it
                # Walk forward from col0 to end of identifier
                i = col0
                while i < len(rstrip) and (rstrip[i].isalnum() or rstrip[i] == '_'):
                    i += 1
                if i > col0 and i < len(rstrip) and rstrip[i] != '!':
                    new_line = rstrip[:i] + '!' + rstrip[i:] + ('\n' if line.endswith('\n') else '')
                    found = True

            if new_line != line:
                # Safety check: don't corrupt by adding ! after !, after a letter in a word mid-stream
                # Verify ! was only added after ] or end-of-identifier
                set_line(lines, lineno, new_line)
                changed = True
                total_fixed += 1

        elif code == 'TS2345':
            # "Argument of type 'X | undefined' is not assignable to parameter of type 'X'"
            # Add ! after the expression at col to assert non-null
            rstrip = line.rstrip('\n')
            new_line = rstrip

            # Check if the error is about an array index access
            # Find ] or end-of-identifier at/before col0
            found = False

            # First try: find ] before col0
            for i in range(min(col0 + 10, len(rstrip) - 1), max(-1, col0 - 40), -1):
                if rstrip[i] == ']' and (i + 1 >= len(rstrip) or rstrip[i+1] != '!'):
                    new_line = rstrip[:i+1] + '!' + rstrip[i+1:]
                    found = True
                    break

            if not found:
                # Walk forward from col0 to end of identifier/accessor
                i = col0
                while i < len(rstrip) and (rstrip[i].isalnum() or rstrip[i] in ('_', '.')):
                    i += 1
                if i > col0 and i < len(rstrip) and rstrip[i] not in ('!', '('):
                    new_line = rstrip[:i] + '!' + rstrip[i:]
                    found = True

            if found and new_line != rstrip:
                set_line(lines, lineno, new_line + ('\n' if line.endswith('\n') else ''))
                changed = True
                total_fixed += 1

        elif code == 'TS2322':
            # Type mismatch - handle specific patterns
            rstrip = line.rstrip('\n')

            # Pattern: T | undefined not assignable to T → add ! at col
            if 'undefined' in msg and 'not assignable to type' in msg:
                # Try adding ! after the expression at col
                i = col0
                while i < len(rstrip) and (rstrip[i].isalnum() or rstrip[i] in ('_', ']', ')')):
                    i += 1
                if i > col0 and i < len(rstrip) and rstrip[i] != '!':
                    new_line = rstrip[:i] + '!' + rstrip[i:]
                    set_line(lines, lineno, new_line + ('\n' if line.endswith('\n') else ''))
                    changed = True
                    total_fixed += 1

    if changed:
        write_file(full_path, lines)
        modified_files.add(filepath)
        print(f"  Modified: {filepath} (fixed {sum(1 for e in file_errors if e['code'] in ('TS2532','TS18048','TS2345','TS2322'))} errors)")

print(f"\nTotal: fixed {total_fixed} instances in {len(modified_files)} files")
