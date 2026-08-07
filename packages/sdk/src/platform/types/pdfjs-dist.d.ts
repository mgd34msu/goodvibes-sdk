declare module 'pdfjs-dist/build/pdf.mjs' {
  export interface PdfTextItem {
    readonly str?: string | undefined;
    readonly hasEOL?: boolean | undefined;
  }

  export interface PdfPageProxy {
    getTextContent(): Promise<{ readonly items: readonly PdfTextItem[] }>;
    cleanup(): void;
  }

  export interface PdfDocumentProxy {
    readonly numPages: number;
    getPage(pageNumber: number): Promise<PdfPageProxy>;
  }

  export interface PdfLoadingTask {
    readonly promise: Promise<PdfDocumentProxy>;
    /** Owns teardown of the document and worker; 6.x removed destroy() from the document proxy. */
    destroy(): Promise<void>;
  }

  export function getDocument(input: {
    readonly data: Uint8Array;
    readonly useSystemFonts?: boolean | undefined;
  }): PdfLoadingTask;
}

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist/build/pdf.mjs';
}
