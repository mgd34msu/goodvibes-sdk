# Generated knowledge pages

Generated pages are a base knowledge/wiki capability. Extensions provide
templates and object profiles, but the base graph owns facts, sources, gaps, and
page refresh mechanics.

See the [knowledge system](./knowledge.md) doc for the underlying data model and
the generated-projection source metadata that backs these pages (the
`metadata.generatedKnowledgePage`, `metadata.projectionKind`, and
`metadata.pageEditable` flags). Home Graph device passports and room/area pages
are documented in [Home Graph extension](./home-graph.md).

## Inputs

A generated page is markdown assembled from verified graph state, not a copy of
raw source text. The base semantic layer produces both the facts and, when a
provider is available, a synthesized page body; a deterministic fallback groups
the same facts by kind (feature, capability, specification, identity,
maintenance, compatibility, configuration, troubleshooting) into markdown
sections when no provider is available or the provider call fails. Either way
the page is built from these graph inputs:

- the subject node the page describes (a device, entity, integration, domain,
  topic, or bookmark folder depending on which extension or projection
  generated the page)
- facts that are linked to that subject through a `describes` edge and pass
  the shared fact-quality filter, so raw snippets, URL/title-only fragments,
  truncated manual fragments, table debris, and affiliate/comparison
  boilerplate never reach the page
- sources reached through those facts, scored by a shared quality policy that
  boosts document/manual sources and known-authority domains and excludes
  shopping, marketplace, and price-comparison pages even if they were
  indexed
- graph neighbors and related generated pages for the same subject, so a page
  can link sideways without the client walking the graph itself
- open issues for that subject, filtered to ones that are still open; an issue
  a review already resolved does not reappear on the page

Pages never render raw extraction snippets as facts. A page can only show a
feature, spec, or capability once the semantic layer has promoted it into a
fact node backed by a source.

## Metadata

Clients read generated pages through the shared page-listing helper rather
than parsing markdown for navigation. Each returned page entry carries the
rendered source and artifact, the resolved subject node, the target node the
page was generated for, graph neighbor nodes with the edges and titles that
connect them, and related generated pages for the same subject. Target and
subject differ for pages generated against an intermediate node: a Home Graph
device passport page's target is the passport record itself, while its
subject is the actual device the passport describes.

Refresh state lives on the generated source and artifact themselves as
`metadata.generatedAt` (when the markdown was last produced) and
`metadata.generatedContentHash` (a hash of that markdown). When a page is
regenerated with identical content, the SDK keeps the existing `generatedAt`
and artifact instead of stamping a new one, so an unchanged page does not look
freshly written every time reindex or sync runs over it.

## Quality

Page generation deduplicates facts that restate the same canonical value under
different titles, so a page does not show "Screen Size: 55 inch" twice because
two sources phrased it differently. It removes sections that end up empty
after filtering, and it rejects table debris such as truncated pipe-delimited
fragments or "quantity table" leftovers that html-to-markdown extraction can
leave behind.

Open questions are suppressed once evidence exists to answer them, so a page
does not keep listing a gap a later source already closed. Numeric
specifications such as screen size, port count, speaker wattage, refresh rate,
dimensions, battery type, and wireless capability are preserved even though
the same filter is aggressive about dropping manual boilerplate, because the
filter recognizes those as concrete, checkable values rather than filler text.
