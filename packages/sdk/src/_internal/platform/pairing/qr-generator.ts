/**
 * QR Code generation using the vendored Nayuki QR Code generator (MIT license).
 * Pure TypeScript, no npm dependencies.
 */
import { qrcodegen } from './vendor/qrcodegen.js';

// The vendored file uses TypeScript namespaces with nested classes.
// Access QrCode and its Ecc inner class through the namespace.
const QrCodeClass = qrcodegen.QrCode;
// Ecc is a static nested class — cast to access it through the @ts-nocheck boundary.
const Ecc = (QrCodeClass as unknown as { Ecc: { LOW: unknown; MEDIUM: unknown; QUARTILE: unknown; HIGH: unknown } }).Ecc;

export interface QrMatrix {
  readonly size: number;
  readonly modules: readonly boolean[][];
}

/**
 * Generate a QR code matrix for the given data string.
 * Uses the Nayuki QR Code generator library (pure TypeScript, vendored).
 */
export function generateQrMatrix(data: string): QrMatrix {
  const qr = QrCodeClass.encodeText(data, Ecc.MEDIUM);
  const size: number = qr.size;
  const modules: boolean[][] = [];

  for (let row = 0; row < size; row++) {
    const rowData: boolean[] = [];
    for (let col = 0; col < size; col++) {
      rowData.push(qr.getModule(col, row));
    }
    modules.push(rowData);
  }

  return { size, modules };
}

/**
 * Render a QR matrix to a Unicode block string suitable for terminal output.
 * Uses half-block characters to pack 2 rows into 1 terminal row.
 */
export function renderQrToString(matrix: QrMatrix): string {
  const { size, modules } = matrix;
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col++) {
      const top = modules[row]?.[col] ?? false;
      const bottom = modules[row + 1]?.[col] ?? false;
      if (top && bottom) line += '\u2588';
      else if (top && !bottom) line += '\u2580';
      else if (!top && bottom) line += '\u2584';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}
