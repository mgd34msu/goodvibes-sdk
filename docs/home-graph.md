# Home Graph Extension

Home Graph is a base-knowledge extension for Home Assistant data. It uses the
same knowledge engine, refinement pipeline, answer synthesis, generated-page
renderer, and contract style as the regular wiki, but it runs against a
separate Home Graph store instance so Home Assistant records do not appear in
the default knowledge/wiki surface.

The extension contributes:

- Home Assistant object profiles for devices, entities, areas, integrations,
  automations, scenes, and scripts
- object linking between HA graph nodes and knowledge sources
- Home Graph map facets
- Home Graph page templates
- Home Assistant-specific quality checks

The extension does not fork a second knowledge implementation. It delegates
source repair, fact extraction, source ranking, generated page refresh,
refinement tasks, and answer synthesis to the base knowledge layer while
persisting graph rows in the Home Graph store.

## Where To Read More

This page is a short orientation. The authoritative description of Home Graph
node kinds, relation names, `HomeGraphService` capabilities, ask behavior, and
daemon routes lives in the
[Home Graph section of the knowledge system doc](./knowledge.md#home-graph).

Generated pages (device passports, room/area pages) and gap repair are shared
base capabilities documented in
[Generated knowledge pages](./knowledge-pages.md) and
[Knowledge refinement](./knowledge-refinement.md). See
[Home Assistant integration](./homeassistant-integration.md) for the broader
Home Assistant daemon routes and operator method ids.
