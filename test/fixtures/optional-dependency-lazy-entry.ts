/**
 * optional-dependency-lazy-entry.ts — the fixed shape, compilable.
 *
 * Built with `bun build --compile` and RUN, because the defect it guards is
 * invisible to a source-level test: under `bun` with a full node_modules tree
 * every one of these packages resolves, so a static import and a dynamic one
 * look identical.
 *
 * It imports the REAL `html-readability.ts` and the REAL `extractors.ts`. The
 * `--external` flags the test compiles it with leave `jsdom` and
 * `@mozilla/readability` as runtime specifiers, and running the artifact from a
 * directory where neither resolves reproduces exactly what an install without
 * the optional packages gives an operator — without touching this repository's
 * node_modules.
 *
 * What it must prove: module init survives, the feature names itself
 * unavailable and says why, and the extractor still returns a result by its
 * lightweight path.
 */

import { describeHtmlReadabilityAvailability } from '../../packages/sdk/src/platform/knowledge/html-readability.ts';
import { extractKnowledgeArtifact } from '../../packages/sdk/src/platform/knowledge/extractors.ts';

// Printed before anything else: a static import of a missing package never
// reaches this line, which is the whole difference being measured.
process.stdout.write('INIT_SURVIVED\n');

const availability = await describeHtmlReadabilityAvailability();
process.stdout.write(`AVAILABLE=${String(availability.available)}\n`);
process.stdout.write(`REASON=${availability.reason ?? 'none'}\n`);

const extracted = await extractKnowledgeArtifact(
  { id: 'fixture', mimeType: 'text/html', filename: 'fixture.html' },
  Buffer.from('<html><head><title>Fixture</title></head><body><h1>Heading</h1><p>Readable body text for the fixture.</p></body></html>'),
);
process.stdout.write(`EXTRACTOR=${extracted.extractorId}\n`);
process.stdout.write(`TITLE=${extracted.title ?? 'none'}\n`);
const warnings = extracted.metadata['warnings'];
process.stdout.write(`WARNING=${Array.isArray(warnings) ? String(warnings[0]) : 'none'}\n`);
