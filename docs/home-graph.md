# Home Graph Extension

Home Graph is a base-knowledge extension for Home Assistant data.

The extension contributes:

- Home Assistant object profiles for devices, entities, areas, integrations,
  automations, scenes, and scripts
- object linking between HA graph nodes and knowledge sources
- Home Graph map facets
- Home Graph page templates
- Home Assistant-specific quality checks

The extension does not own a separate knowledge system. It delegates source
repair, fact extraction, source ranking, generated page refresh, refinement
tasks, and answer synthesis to the base knowledge layer.

## Generated Pages

Device passports and room pages are generated pages backed by the same graph
facts and source links as other knowledge pages. Pages should render useful
verified facts, related objects, and navigation links. They should not render
global gap dumps, resolved issues, or raw manual boilerplate.

## Ask Behavior

Home Graph Ask narrows candidate objects and sources to the matched HA subject,
then calls base knowledge Ask. Concrete questions such as "what features does
the TV have?" should resolve the real HA object, repair gaps when needed, and
return source-backed facts or explicit deferred repair metadata.
