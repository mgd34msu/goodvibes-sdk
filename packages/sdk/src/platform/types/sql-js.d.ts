/**
 * SDK-owned platform module. This implementation is maintained in goodvibes-sdk.
 *
 * `sql.js` ships no types of its own, so this is the one place its shape is
 * written. It is an ambient declaration, which means tsc treats it as an input
 * and never emits it — `scripts/prepare-sdk-package.ts` copies it into dist
 * after the build so it reaches the published package.
 *
 * A consumer that imports `sql.js` picks this up with one line, anywhere in
 * its own sources:
 *
 *     /// <reference types="@pellux/goodvibes-sdk/sql-js" />
 *
 * Editing this file changes the shape for every surface at once; there are no
 * per-repo copies to keep in step.
 */

declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
    exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: Uint8Array | Buffer) => Database;
  }

  function initSqlJs(): Promise<SqlJsStatic>;
  export default initSqlJs;
}
