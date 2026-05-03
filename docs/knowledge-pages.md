# Generated Knowledge Pages

Generated pages are a base knowledge/wiki capability. Extensions provide
templates and object profiles, but the base graph owns facts, sources, gaps, and
page refresh mechanics.

## Inputs

Pages are generated from verified graph state:

- subject nodes
- promoted subject-linked facts
- fact-source edges
- source quality and authority
- graph neighbors and related generated pages
- open issues only when still true

Pages do not render raw extraction snippets as facts.

## Metadata

A generated page should expose subject id/kind, target id/kind, source ids,
fact ids, related page ids, graph neighbor edges/titles, and refresh state. UI
layers should not need to scrape markdown to build navigation.

## Quality

Page generation deduplicates canonical facts, suppresses stale open questions
when evidence exists, removes empty sections, and rejects table debris. Numeric
specifications such as screen size, port count, speaker wattage, refresh rate,
dimensions, battery type, and wireless capability are preserved when relevant.
