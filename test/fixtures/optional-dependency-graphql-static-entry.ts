/**
 * optional-dependency-graphql-static-entry.ts — the shape that shipped, on
 * purpose, for one of the newly converted packages.
 *
 * The control for the compiled-binary test beside it. This is exactly what
 * `knowledge/graphql-schema.ts` and `knowledge/graphql.ts` used to do: a static
 * `import { buildSchema } from 'graphql'` plus a schema built in an initialiser
 * that runs at MODULE INIT (there it was a class static,
 * `static readonly schema = buildSchema(KNOWLEDGE_GRAPHQL_SDL)`). Both modules
 * are on the daemon's graph through the knowledge service.
 *
 * Compiled and run where the package does not resolve, it produces exit 1 with
 * ZERO bytes on stdout — the process is gone before its first statement, before
 * `main()`, before the activity logger has a destination, and before
 * daemon/fatal-boot-report.ts can say anything about it. That is the state this
 * fixture holds still, so nobody restores a static import of an optional
 * package without a test turning red. The lazy fixture beside it, compiled with
 * the same `--external` flags and run in the same place, reaches its first line
 * and names every package it is missing.
 */

import { buildSchema, printSchema } from 'graphql';

const SCHEMA = buildSchema('type Query { ready: Boolean! }');

process.stdout.write('INIT_SURVIVED\n');
process.stdout.write(`SCHEMA=${printSchema(SCHEMA).length}\n`);
