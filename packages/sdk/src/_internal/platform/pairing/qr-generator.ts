import { execSync } from 'node:child_process';

export interface QrMatrix {
  readonly size: number;
  readonly modules: readonly boolean[][];
}

/**
 * Attempt to generate a QR matrix by shelling out to `qrencode`.
 * Returns null if qrencode is not available or fails.
 */
function tryQrencode(data: string): QrMatrix | null {
  try {
    // -t ASC outputs a 2-character-per-module ASCII representation:
    // '##' = dark module, '  ' = light module, with a surrounding quiet zone
    // We use -t UTF8i (inverted) if available, or fall back to -t ASC.
    // qrencode -t ASC outputs lines like: '######  ##  ######'
    // where each character is one module.
    // We request -m 0 (no margin) and -s 1 for raw matrix output.
    const output = execSync(
      `qrencode -m 0 -t ASC ${JSON.stringify(data)}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
    );
    const rawLines = output.split('\n').filter((l) => l.length > 0);
    if (rawLines.length === 0) return null;

    // qrencode ASC mode: each module is 2 characters wide ('##' dark, '  ' light)
    const modules: boolean[][] = rawLines.map((line) => {
      const row: boolean[] = [];
      for (let i = 0; i < line.length; i += 2) {
        const pair = line.slice(i, i + 2);
        row.push(pair === '##');
      }
      return row;
    });

    const size = modules[0]?.length ?? 0;
    // Normalize all rows to the same size
    const normalized = modules.map((row) => {
      while (row.length < size) row.push(false);
      return row.slice(0, size);
    });

    return { size, modules: normalized };
  } catch {
    return null;
  }
}

/**
 * Minimal fallback QR matrix generator using a tiny Reed-Solomon QR implementation.
 * Supports QR versions 1-9 (up to ~134 bytes, ECC level M).
 *
 * This is a self-contained implementation suitable for short connection strings.
 */
function generateQrMatrixMinimal(data: string): QrMatrix {
  const bytes = new TextEncoder().encode(data);
  const len = bytes.length;

  // Version selection table: [version, dataCapacityBytes at ECC-M]
  // Source: QR code spec Table 9
  const versionTable: [number, number][] = [
    [1, 16], [2, 28], [3, 44], [4, 64], [5, 86],
    [6, 108], [7, 124], [8, 154], [9, 182], [10, 216],
  ];

  let version = 0;
  for (const [v, cap] of versionTable) {
    if (len <= cap) { version = v; break; }
  }
  if (version === 0) {
    throw new Error(`Data too long for minimal QR generator (${len} bytes, max 216)`);
  }

  // Total codewords and ECC codewords per block (ECC level M)
  // [version]: [totalCodewords, eccCodewords, blocks]
  const eccTable: Record<number, [number, number, number]> = {
    1: [26, 10, 1], 2: [44, 16, 1], 3: [70, 26, 2],
    4: [100, 36, 2], 5: [134, 48, 2], 6: [172, 64, 4],
    7: [196, 72, 4], 8: [242, 88, 4], 9: [292, 110, 5],
    10: [346, 130, 5],
  };

  const [totalCodewords, eccPerBlock, numBlocks] = eccTable[version]!;
  const dataCodewords = totalCodewords - (eccPerBlock * numBlocks);

  // Build data bit stream: mode (byte=0100), char count, data, terminator, padding
  const bits: number[] = [];
  function pushBits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      bits.push((value >> i) & 1);
    }
  }

  // Mode indicator: byte mode = 0100
  pushBits(0b0100, 4);
  // Character count indicator (version 1-9: 8 bits for byte mode)
  pushBits(len, 8);
  // Data bytes
  for (const b of bytes) pushBits(b, 8);
  // Terminator (up to 4 zero bits)
  const maxBits = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad codewords
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < maxBits) {
    pushBits(padBytes[padIdx % 2]!, 8);
    padIdx++;
  }

  // Convert bits to bytes
  const dataBytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] ?? 0);
    dataBytes.push(b);
  }

  // Split into blocks and compute ECC
  const dataPerBlock = Math.floor(dataCodewords / numBlocks);
  const extraBlocks = dataCodewords - dataPerBlock * numBlocks;
  const blocks: number[][] = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const blockLen = dataPerBlock + (b < extraBlocks ? 1 : 0);
    blocks.push(dataBytes.slice(offset, offset + blockLen));
    offset += blockLen;
  }

  // Reed-Solomon ECC generation
  function gfMul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    const logTable = buildLogTable();
    const expTable = buildExpTable();
    return expTable[(logTable[a]! + logTable[b]!) % 255]!;
  }

  // Lazily built lookup tables (closured)
  let _expTable: number[] | null = null;
  let _logTable: number[] | null = null;

  function buildExpTable(): number[] {
    if (_expTable) return _expTable;
    _expTable = new Array<number>(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      _expTable[i] = x;
      x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
    }
    _expTable[255] = _expTable[0]!;
    return _expTable;
  }

  function buildLogTable(): number[] {
    if (_logTable) return _logTable;
    const exp = buildExpTable();
    _logTable = new Array<number>(256).fill(0);
    for (let i = 0; i < 255; i++) _logTable[exp[i]!] = i;
    return _logTable;
  }

  function rsEcc(data: number[], eccCount: number): number[] {
    // Generator polynomial for eccCount error correction codewords
    const expTable = buildExpTable();
    const logTable = buildLogTable();
    // Build generator polynomial
    let gen = [1];
    for (let i = 0; i < eccCount; i++) {
      const factor = [1, expTable[i]!];
      const newGen = new Array<number>(gen.length + factor.length - 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        for (let k = 0; k < factor.length; k++) {
          newGen[j + k] ^= gfMul(gen[j]!, factor[k]!);
        }
      }
      gen = newGen;
    }
    // Polynomial long division
    const msg = [...data, ...new Array<number>(eccCount).fill(0)];
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i]!;
      if (coef !== 0) {
        const log = logTable[coef]!;
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j]!, expTable[(log + logTable[gen[j]!]!) % 255]! / gen[j]! | 0);
          // Correct formula using logs:
          if (gen[j] !== 0) {
            msg[i + j] ^= expTable[(log + logTable[gen[j]!]!) % 255]!;
            // undo the wrong xor above
            msg[i + j] ^= gfMul(gen[j]!, expTable[(log + logTable[gen[j]!]!) % 255]! / gen[j]! | 0);
          }
        }
      }
    }
    return msg.slice(data.length);
  }

  // Simpler, correct RS ECC implementation:
  function rsEccCorrect(data: number[], eccCount: number): number[] {
    const expTable = buildExpTable();
    const logTable = buildLogTable();
    let gen = [1];
    for (let i = 0; i < eccCount; i++) {
      const factor = [1, expTable[i]!];
      const newGen = new Array<number>(gen.length + factor.length - 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        for (let k = 0; k < factor.length; k++) {
          newGen[j + k] ^= gfMul(gen[j]!, factor[k]!);
        }
      }
      gen = newGen;
    }
    const msg = [...data, ...new Array<number>(eccCount).fill(0)];
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i]!;
      if (coef !== 0) {
        const logCoef = logTable[coef]!;
        for (let j = 1; j < gen.length; j++) {
          if (gen[j] !== 0) {
            msg[i + j] ^= expTable[(logCoef + logTable[gen[j]!]!) % 255]!;
          }
        }
      }
    }
    return msg.slice(data.length);
  }

  // Interleave blocks and compute ECC
  const eccBlocks = blocks.map((b) => rsEccCorrect(b, eccPerBlock));

  const finalBytes: number[] = [];
  // Interleave data blocks
  const maxDataLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) finalBytes.push(block[i]!);
    }
  }
  // Interleave ECC blocks
  for (let i = 0; i < eccPerBlock; i++) {
    for (const ecc of eccBlocks) {
      finalBytes.push(ecc[i]!);
    }
  }

  // Build the QR matrix
  const size = 21 + (version - 1) * 4;
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );

  function setModule(row: number, col: number, dark: boolean): void {
    if (row >= 0 && row < size && col >= 0 && col < size) {
      matrix[row]![col] = dark;
    }
  }

  // Place finder pattern
  function placeFinderPattern(r: number, c: number): void {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const inOuter = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
        const inWhite = dy >= 1 && dy <= 5 && dx >= 1 && dx <= 5;
        const inInner = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        if (!inOuter) {
          setModule(r + dy, c + dx, false); // separator
        } else if (inWhite && !inInner) {
          setModule(r + dy, c + dx, false);
        } else {
          setModule(r + dy, c + dx, inInner || (dy === 0 || dy === 6 || dx === 0 || dx === 6));
        }
      }
    }
  }

  placeFinderPattern(0, 0);
  placeFinderPattern(0, size - 7);
  placeFinderPattern(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(6, i, dark);
    setModule(i, 6, dark);
  }

  // Alignment patterns (version >= 2)
  const alignmentPositions: Record<number, number[]> = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42],
    9: [6, 28, 46], 10: [6, 28, 50],
  };
  const alignPos = version >= 2 ? alignmentPositions[version] ?? [] : [];
  for (const r of alignPos) {
    for (const c of alignPos) {
      // Skip positions occupied by finder patterns
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 8) || (r >= size - 8 && c <= 8)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const isEdge = Math.abs(dy) === 2 || Math.abs(dx) === 2;
          const isCenter = dy === 0 && dx === 0;
          setModule(r + dy, c + dx, isEdge || isCenter);
        }
      }
    }
  }

  // Dark module (always dark)
  setModule(4 * version + 9, 8, true);

  // Format information area — reserve (mark as false for now)
  for (let i = 0; i < 9; i++) {
    setModule(8, i, matrix[8]?.[i] ?? false);
    setModule(i, 8, matrix[i]?.[8] ?? false);
  }
  for (let i = size - 8; i < size; i++) {
    setModule(8, i, false);
    setModule(i, 8, false);
  }

  // Place data bits (zigzag pattern)
  const allBits: number[] = [];
  for (const b of finalBytes) {
    for (let i = 7; i >= 0; i--) allBits.push((b >> i) & 1);
  }

  let bitIdx = 0;
  let goUp = true;
  // Right-to-left column pairs, skipping column 6 (timing)
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col--; // skip timing column
    const colRange = goUp
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);
    for (const row of colRange) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (matrix[row]?.[c] === null) {
          const bit = allBits[bitIdx++] ?? 0;
          matrix[row]![c] = bit === 1;
        }
      }
    }
    goUp = !goUp;
  }

  // Apply mask pattern 0 (checkerboard: (row + col) % 2 === 0)
  // and place format information
  const maskFn = (r: number, c: number): boolean => (r + c) % 2 === 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const module = matrix[r]?.[c];
      if (module === null) {
        matrix[r]![c] = false; // unfilled = light
      } else {
        // Only apply mask to data modules (not function patterns)
        // We re-apply masking carefully: function patterns are already fixed
        // Data modules that were null are now set above
      }
    }
  }

  // Apply mask to data modules (those placed via zigzag)
  bitIdx = 0;
  goUp = true;
  const maskedMatrix: boolean[][] = matrix.map((row) => row.map((m) => m ?? false));
  // Reset data area and re-place with masking
  {
    const tempMatrix: (boolean | null)[][] = matrix.map((row) => [...row]);
    // Re-mark data positions as null
    let bi = 0;
    let gu = true;
    for (let col = size - 1; col >= 1; col -= 2) {
      if (col === 6) col--;
      const colRange = gu
        ? Array.from({ length: size }, (_, i) => size - 1 - i)
        : Array.from({ length: size }, (_, i) => i);
      for (const row of colRange) {
        for (const dc of [0, -1]) {
          const c = col + dc;
          if (tempMatrix[row]?.[c] !== null) {
            // was set as data, apply mask
            const dark = (allBits[bi++] ?? 0) === 1;
            maskedMatrix[row]![c] = maskFn(row, c) ? !dark : dark;
          }
        }
      }
      gu = !gu;
    }
  }

  // Format string for ECC level M (01), mask pattern 0 (000)
  // Format info = 01000 XOR 101010000010010 = 110010111100101
  // Precomputed: ECC-M + mask-0 = format bits 101000000100101 (with BCH)
  // Using known correct value for M+mask0: 0x5647 -> bits[14..0]
  // Actually standard value: ECC-M=1, mask=0 -> data=01_000 -> format=01000 00000000
  // BCH(01000)=0100000000+BCH = let's use precomputed: 0x72F3 for M+mask2, etc.
  // Correct precomputed format words (ECC-M=0b01, masks 0-7):
  const formatWords: number[] = [
    0x5412, 0x5125, 0x5E7C, 0x5B4B, 0x45F9, 0x40CE, 0x4F97, 0x4AA0,
  ];
  const formatWord = formatWords[0]!; // mask 0
  const formatXor = 0b101010000010010;
  const fmt = (formatWord ^ formatXor) & 0x7FFF;
  const fmtBits = Array.from({ length: 15 }, (_, i) => (fmt >> (14 - i)) & 1);

  // Place format bits around finder patterns
  // Around top-left finder:
  const fmtPositions1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  fmtPositions1.forEach(([r, c], i) => {
    maskedMatrix[r!]![c!] = fmtBits[i] === 1;
  });
  // Around top-right and bottom-left finders:
  const fmtPositions2 = [
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  fmtPositions2.forEach(([r, c], i) => {
    maskedMatrix[r!]![c!] = fmtBits[i] === 1;
  });
  const fmtPositions3 = [
    [size - 7, 8], [size - 6, 8], [size - 5, 8],
    [size - 4, 8], [size - 3, 8], [size - 2, 8], [size - 1, 8],
  ];
  fmtPositions3.forEach(([r, c], i) => {
    maskedMatrix[r!]![c!] = fmtBits[i + 8] === 1;
  });

  return { size, modules: maskedMatrix };
}

/**
 * Generate a QR code matrix for the given data string.
 * Tries qrencode CLI first; falls back to minimal built-in implementation.
 */
export function generateQrMatrix(data: string): QrMatrix {
  const fromCli = tryQrencode(data);
  if (fromCli !== null) return fromCli;
  return generateQrMatrixMinimal(data);
}

/**
 * Render a QR matrix to a Unicode block string suitable for terminal output.
 * Uses half-block characters to pack 2 rows into 1 terminal row.
 *
 * - Full block `█` = dark top + dark bottom
 * - Upper half `▀` = dark top + light bottom
 * - Lower half `▄` = light top + dark bottom
 * - Space ` ` = light top + light bottom
 */
export function renderQrToString(matrix: QrMatrix): string {
  const { size, modules } = matrix;
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col++) {
      const top = modules[row]?.[col] ?? false;
      const bottom = modules[row + 1]?.[col] ?? false;
      if (top && bottom) line += '\u2588'; // full block
      else if (top && !bottom) line += '\u2580'; // upper half
      else if (!top && bottom) line += '\u2584'; // lower half
      else line += ' '; // space
    }
    lines.push(line);
  }
  return lines.join('\n');
}
