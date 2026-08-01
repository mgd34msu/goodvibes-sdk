import { describe, expect, test } from 'bun:test';
import { createBottomBarLine, writeBottomBarText } from '@pellux/goodvibes-terminal-shell';

describe('bottom bar renderer', () => {
  test('writes wide-character text without breaking terminal width', () => {
    const line = createBottomBarLine(40, { fg: '#000000', bg: '#00ffcc' });
    writeBottomBarText(line, 0, 40, '界🙂 search', { fg: '#000000', bg: '#00ffcc' });
    expect(line).toHaveLength(40);
  });
});
