/**
 * The clipboard readers sit here, so the explanation for why they cannot run
 * sits next to them, one answer for every surface that pastes.
 *
 * A terminal hands a program text, never an image: bracketed paste and OSC 52
 * both carry characters. Reading a pasted image therefore means shelling out to
 * a clipboard helper, and on Linux that helper is a package that may not be
 * installed. Reporting that as "the clipboard has nothing in it" sent people
 * looking for a broken key instead of running one install command.
 */
import { describe, expect, test } from 'bun:test';
import { missingClipboardReaderHint } from '../packages/sdk/src/platform/utils/clipboard.ts';

const nothingInstalled = () => false;

describe('missingClipboardReaderHint', () => {
  test('names wl-clipboard on a Wayland session with no reader installed', () => {
    const hint = missingClipboardReaderHint({ platform: 'linux', wayland: true, has: nothingInstalled });
    expect(hint).toContain('wl-clipboard');
    expect(hint).toContain('Wayland');
  });

  test('names xclip on an X11 session with no reader installed', () => {
    const hint = missingClipboardReaderHint({ platform: 'linux', wayland: false, has: nothingInstalled });
    expect(hint).toContain('xclip');
    expect(hint).toContain('X11');
  });

  test('either reader being present silences the hint', () => {
    expect(missingClipboardReaderHint({ platform: 'linux', has: t => t === 'wl-paste' })).toBeUndefined();
    expect(missingClipboardReaderHint({ platform: 'linux', has: t => t === 'xclip' })).toBeUndefined();
  });

  test('macOS and Windows need no extra package, so they get no hint', () => {
    expect(missingClipboardReaderHint({ platform: 'darwin', has: nothingInstalled })).toBeUndefined();
    expect(missingClipboardReaderHint({ platform: 'win32', has: nothingInstalled })).toBeUndefined();
  });

  test('the hint gives a runnable install command', () => {
    const hint = missingClipboardReaderHint({ platform: 'linux', wayland: true, has: nothingInstalled }) ?? '';
    expect(hint).toContain('pacman -S wl-clipboard');
    expect(hint).toContain('apt install wl-clipboard');
  });
});
