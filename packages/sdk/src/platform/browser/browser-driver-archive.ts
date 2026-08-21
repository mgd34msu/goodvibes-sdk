/**
 * The tar reader browser-driver provisioning uses.
 *
 * Provisioning downloads the Playwright driver package straight from the npm
 * registry and writes the tree to disk. That is release-critical and must not
 * depend on a `tar` binary existing on the machine, and it is the one piece of
 * concrete node I/O in this module that had no existing injection seam, so
 * the header parsing lives here, beside its only caller, rather than becoming
 * a port every product would have to fill before the driver could install
 * itself.
 *
 * Scope is deliberately narrow, the archives this reads are ustar archives
 * npm or a release workflow produced: regular files and directories, short
 * paths, no sparse entries. Anything else in the stream is skipped rather than
 * guessed at, and every extracted path is checked against its destination
 * before a single byte is written.
 */
import { gunzipSync } from 'node:zlib';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const TAR_BLOCK = 512;

export type TarEntryKind = 'file' | 'directory' | 'other';

export interface TarEntry {
  /** Entry path exactly as archived, with any leading `./` removed. */
  readonly path: string;
  readonly kind: TarEntryKind;
  /** Permission bits from the header (the low 12 bits of the mode field). */
  readonly mode: number;
  /** File bytes. Empty for directories. */
  readonly data: Buffer;
}

function readTarString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.toString('utf-8', 0, nul === -1 ? length : nul);
}

function classify(typeflag: number | undefined, name: string): TarEntryKind {
  // NUL and '0' are regular files; '5' is a directory. A name ending in '/'
  // with no typeflag is how some writers spell a directory.
  if (typeflag === 0x35) return 'directory';
  if (typeflag === 0 || typeflag === 0x30) return name.endsWith('/') ? 'directory' : 'file';
  return 'other';
}

/**
 * Walks every entry of a gzipped tar in archive order.
 *
 * Throws when the gzip stream does not decompress: a corrupted download must
 * fail loudly, never read as "the archive was empty".
 */
export function* readTarGzEntries(archive: Buffer | Uint8Array): Generator<TarEntry> {
  const tar = gunzipSync(archive);
  let offset = 0;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    // Two consecutive zero blocks end the archive; a zero name block is enough here.
    if (header[0] === 0) return;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeOctal = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeOctal || '0', 8);
    if (!Number.isFinite(size) || size < 0) return;
    const modeOctal = readTarString(header, 100, 8).trim();
    const parsedMode = Number.parseInt(modeOctal || '0', 8);
    const kind = classify(header[156], fullName);
    const normalized = fullName.startsWith('./') ? fullName.slice(2) : fullName;
    const dataStart = offset + TAR_BLOCK;
    if (dataStart + size > tar.length) return;
    yield {
      path: normalized,
      kind,
      mode: Number.isFinite(parsedMode) ? parsedMode & 0o7777 : 0o644,
      data: kind === 'file' ? Buffer.from(tar.subarray(dataStart, dataStart + size)) : Buffer.alloc(0),
    };
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
}

/**
 * Extract one regular-file entry by its exact path. Returns the file bytes, or
 * null when the archive holds no such entry.
 */
export function extractTarGzEntry(archive: Buffer | Uint8Array, entryPath: string): Buffer | null {
  for (const entry of readTarGzEntries(archive)) {
    if (entry.kind === 'file' && entry.path === entryPath) return entry.data;
  }
  return null;
}

export interface ExtractTarGzTreeOptions {
  /**
   * Leading path components to drop from every entry. npm tarballs put
   * everything under `package/`, so extracting one uses stripComponents: 1.
   */
  readonly stripComponents?: number;
  /** Called for each written file, so a caller can report what it installed. */
  readonly onFile?: (relativePath: string) => void;
}

export interface ExtractTarGzTreeResult {
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

/**
 * Rejects an archived path that would write outside the destination.
 *
 * An absolute path, a `..` segment, or a Windows drive prefix is refused rather
 * than sanitized: an archive that contains one is not the archive we meant to
 * extract, and quietly rewriting it would hide that.
 */
function safeJoin(destination: string, relativePath: string): string {
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`archive entry ${relativePath} is an absolute path`);
  }
  if (relativePath.split(/[\\/]/).includes('..')) {
    throw new Error(`archive entry ${relativePath} escapes the destination directory`);
  }
  const target = resolve(destination, relativePath);
  const root = resolve(destination);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`archive entry ${relativePath} resolves outside ${destination}`);
  }
  return target;
}

function strip(path: string, components: number): string | null {
  if (components <= 0) return path;
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= components) return null;
  return parts.slice(components).join('/');
}

/**
 * Writes every regular file and directory of a gzipped tar under `destination`,
 * preserving the executable bit (playwright-core ships shell helpers and an
 * `xdg-open` that must stay runnable). Entries that are neither files nor
 * directories, symlinks, devices, hard links, are skipped, because nothing
 * this extracts is supposed to contain any.
 */
export function extractTarGzTree(
  archive: Buffer | Uint8Array,
  destination: string,
  options: ExtractTarGzTreeOptions = {},
): ExtractTarGzTreeResult {
  const stripComponents = options.stripComponents ?? 0;
  let files = 0;
  let directories = 0;
  let bytes = 0;
  mkdirSync(destination, { recursive: true });
  for (const entry of readTarGzEntries(archive)) {
    if (entry.kind === 'other') continue;
    const relative = strip(entry.path, stripComponents);
    if (relative === null || relative.length === 0) continue;
    const target = safeJoin(destination, relative);
    if (entry.kind === 'directory') {
      mkdirSync(target, { recursive: true });
      directories += 1;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    // Only the executable bit is carried across; everything else gets ordinary
    // file permissions so an archive cannot make something setuid or
    // world-writable on the way in.
    chmodSync(target, (entry.mode & 0o111) === 0 ? 0o644 : 0o755);
    files += 1;
    bytes += entry.data.length;
    options.onFile?.(relative);
  }
  return { files, directories, bytes };
}
