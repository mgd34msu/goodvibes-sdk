declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface PdfTextItem {
    readonly str?: string;
    readonly hasEOL?: boolean;
  }

  export interface PdfPageProxy {
    getTextContent(): Promise<{ readonly items: readonly PdfTextItem[] }>;
    cleanup(): void;
  }

  export interface PdfDocumentProxy {
    readonly numPages: number;
    getPage(pageNumber: number): Promise<PdfPageProxy>;
    destroy(): Promise<void>;
  }

  export interface PdfLoadingTask {
    readonly promise: Promise<PdfDocumentProxy>;
  }

  export function getDocument(input: {
    readonly data: Uint8Array;
    readonly useSystemFonts?: boolean;
  }): PdfLoadingTask;
}
