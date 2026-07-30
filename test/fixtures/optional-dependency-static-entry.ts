/**
 * optional-dependency-static-entry.ts — the shape that shipped, on purpose.
 *
 * The control for the compiled-binary test beside it. This is exactly what
 * `knowledge/html-readability.ts` used to do: a static
 * `import { JSDOM } from 'jsdom'` at the top of a module the daemon's graph
 * reaches through knowledge/extractors.ts.
 *
 * Compiled and run where the package does not resolve, it produces exit 1 with
 * ZERO bytes on stdout — the process is gone before its first statement, before
 * `main()`, before the activity logger has a destination, and before
 * daemon/fatal-boot-report.ts can say anything about it. That is the state this
 * fixture holds still, so nobody restores a static import of an optional
 * package without a test turning red.
 */

import { JSDOM } from 'jsdom';

process.stdout.write('INIT_SURVIVED\n');
process.stdout.write(`JSDOM=${typeof JSDOM}\n`);
