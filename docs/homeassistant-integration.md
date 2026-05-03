# Home Assistant Integration

Home Assistant support is an SDK-owned daemon surface. The Home Assistant
custom integration lives in a separate project, but it should treat the daemon
as the source of truth for pairing, prompts, tool catalogs, agent tools, replies,
and Home Assistant REST-backed operations.

The SDK defaults this surface off. Hosts must enable both the feature flag and
the surface config before Home Assistant ingress or delivery is active:

```json
{
  "featureFlags": {
    "homeassistant-surface": "enabled"
  },
  "surfaces": {
    "homeassistant": {
      "enabled": true
    }
  }
}
```

The implementation follows Home Assistant's first-class integration patterns:
config flows create config entries, device registry entries represent services
or devices, integration service actions are registered at setup time, the REST
API uses bearer tokens and JSON payloads, and the WebSocket API is available for
event streaming when the Home Assistant integration needs a live connection.

References:

- [Home Assistant REST API](https://developers.home-assistant.io/docs/api/rest/)
- [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/)
- [Home Assistant config flows](https://developers.home-assistant.io/docs/core/integration/config_flow/)
- [Home Assistant device registry](https://developers.home-assistant.io/docs/device_registry_index/)
- [Home Assistant service actions](https://developers.home-assistant.io/docs/dev_101_services/)

## SDK Contract

### Feature Flag

`homeassistant-surface` gates the Home Assistant surface. It is disabled by
default and must be enabled explicitly by hosts that expose Home Assistant.

### Config Keys

| Key | Default | Purpose |
|---|---:|---|
| `surfaces.homeassistant.enabled` | `false` | Enables Home Assistant ingress and delivery. |
| `surfaces.homeassistant.instanceUrl` | `""` | Home Assistant base URL, for example `http://homeassistant.local:8123`. |
| `surfaces.homeassistant.accessToken` | `""` | Home Assistant long-lived access token or `goodvibes://` secret URI for daemon-to-HA REST calls. |
| `surfaces.homeassistant.webhookSecret` | `""` | Shared secret required on HA-to-daemon webhook calls. |
| `surfaces.homeassistant.defaultConversationId` | `"goodvibes"` | Default conversation/route id for Home Assistant-originated prompts. |
| `surfaces.homeassistant.deviceId` | `"goodvibes-daemon"` | Stable daemon device identifier presented to Home Assistant setup flows. |
| `surfaces.homeassistant.deviceName` | `"GoodVibes Daemon"` | Display name for the daemon device. |
| `surfaces.homeassistant.eventType` | `"goodvibes_message"` | Home Assistant event type used for daemon-to-HA deliveries. |
| `surfaces.homeassistant.remoteSessionTtlMs` | `1200000` | Idle TTL for daemon-owned Home Assistant remote sessions. Default is 20 minutes. |

Supported environment fallbacks:

- `HOMEASSISTANT_URL`, `HOME_ASSISTANT_URL`, `HA_URL`
- `HOMEASSISTANT_ACCESS_TOKEN`, `HOME_ASSISTANT_ACCESS_TOKEN`, `HA_ACCESS_TOKEN`
- `HOMEASSISTANT_WEBHOOK_SECRET`, `HOME_ASSISTANT_WEBHOOK_SECRET`,
  `HA_GOODVIBES_WEBHOOK_SECRET`

### Manifest and Setup Discovery

The Home Assistant integration should call daemon channel endpoints during
config flow setup. The most useful endpoints are:

| Endpoint | Purpose |
|---|---|
| `GET /api/channels/setup/homeassistant` | Setup schema, secret targets, and external setup steps. |
| `GET /api/channels/accounts/homeassistant` | Account/config posture and safe secret-source summaries. |
| `GET /api/channels/capabilities/homeassistant` | Surface capabilities. |
| `GET /api/channels/tools/homeassistant` | Home Assistant surface tools. |
| `GET /api/channels/agent-tools/homeassistant` | Tool definitions safe to expose into GoodVibes agent runtimes. |
| `GET /api/channels/actions/homeassistant` | Operator actions. |
| `POST /api/channels/actions/homeassistant/homeassistant-manifest` | Daemon/device manifest consumed by the HA integration. |
| `POST /api/channels/actions/homeassistant/homeassistant-status` | Checks HA API reachability and token posture. |
| `GET /api/homeassistant/health` | Authenticated surface health, capabilities, endpoints, and default remote-session TTL. |
| `POST /api/homeassistant/conversation` | Submit an Assist-style conversation turn and wait for the final assistant reply. |
| `POST /api/homeassistant/conversation/stream` | Submit a conversation turn over SSE and receive one `final` or `error` event. |
| `POST /api/homeassistant/conversation/cancel` | Close a running Home Assistant conversation by `sessionId` or known `messageId`. |
| `GET /api/homeassistant/home-graph/status` | Home Graph status for an isolated HA knowledge space. |
| `POST /api/homeassistant/home-graph/sync` | Sync entity/device/area/automation/script/scene/label/integration snapshots. |
| `POST /api/homeassistant/home-graph/ingest/url` | Ingest a manual/product URL into the HA knowledge space. |
| `POST /api/homeassistant/home-graph/ingest/note` | Store a note or "remember this about my house" fact. |
| `POST /api/homeassistant/home-graph/ingest/artifact` | Ingest an existing artifact, path/URI reference, multipart file upload, or raw binary upload as a document, photo, receipt, or warranty. |
| `POST /api/homeassistant/home-graph/link` | Attach a source or fact to an HA object. |
| `POST /api/homeassistant/home-graph/unlink` | Mark a source/object link inactive without deleting history. |
| `POST /api/homeassistant/home-graph/ask` | Ask source-backed questions over only the HA knowledge space; responses use the shared semantic wiki answer layer instead of raw snippet dumps. |
| `POST /api/homeassistant/home-graph/reindex` | Reparse already-stored HA Home Graph artifacts whose extraction is missing, placeholder-only, or from the old placeholder PDF extractor, then refresh semantic facts/pages/gaps. |
| `POST /api/homeassistant/home-graph/device-passport` | Refresh and materialize a device passport page. |
| `POST /api/homeassistant/home-graph/room-page` | Generate a room/area page as markdown artifact. |
| `POST /api/homeassistant/home-graph/packet` | Generate guest, sitter, emergency, contractor, network, or custom packets. |
| `GET /api/homeassistant/home-graph/pages` | List generated Home Graph wiki pages with markdown content for previews/editors. |
| `GET /api/homeassistant/home-graph/issues` | List Home Graph data-quality/review issues. |
| `POST /api/homeassistant/home-graph/facts/review` | Accept, reject, resolve, edit, or forget a graph issue/source/node. |
| `GET /api/homeassistant/home-graph/refinement/tasks` | List durable Home Graph refinement tasks and traces. |
| `GET /api/homeassistant/home-graph/refinement/tasks/{id}` | Inspect one refinement task. |
| `POST /api/homeassistant/home-graph/refinement/run` | Run source-backed gap refinement for the HA knowledge space. Accepts `limit`, `maxRunMs`, `gapIds`, `sourceIds`, and `force`; broad limits are capped by the SDK and reported in the result. |
| `POST /api/homeassistant/home-graph/refinement/tasks/{id}/cancel` | Cancel a queued or active refinement task. |
| `GET /api/homeassistant/home-graph/sources` | Browse source inventory and provenance for the HA space. |
| `GET /api/homeassistant/home-graph/browse` | Browse namespace-filtered nodes, edges, sources, and issues. |
| `GET`/`POST /api/homeassistant/home-graph/map` | Return a visual node/edge map as JSON layout data plus SVG, or SVG directly with `format=svg`. |
| `POST /api/homeassistant/home-graph/export` | Export the HA knowledge space. |
| `POST /api/homeassistant/home-graph/import` | Import a HA knowledge space export. |
| `POST /api/homeassistant/home-graph/reset` | Admin-only reset for one HA knowledge space. Pass `dryRun: true` to preview delete counts without changing storage. Export first if the current graph may be needed for diagnosis. Reset clears graph rows and deletes artifacts for the selected HA space by default; pass `preserveArtifacts: true` only for a records-only reset. |

All daemon API calls require normal daemon authentication. The inbound webhook
below additionally requires the Home Assistant webhook secret because webhook
routes are evaluated before daemon bearer auth. The `/api/homeassistant/*`
conversation routes use normal daemon bearer auth and are the preferred path
for Home Assistant Assist conversation agents.

### Home Graph

Home Graph is the SDK-owned knowledge/wiki layer for Home Assistant. The HA
integration collects context and calls daemon APIs; the daemon stores,
searches, links, reviews, exports, and renders the graph. Home Graph records are
not written into the default GoodVibes knowledge space. By default the SDK uses
`homeassistant:<installationId>` as the `knowledgeSpaceId`, and every Home Graph
source, node, edge, issue, extraction, projection artifact, and export carries
that space metadata.

Read-only Home Graph routes can infer the active Home Assistant knowledge space
when a client omits `installationId` and `knowledgeSpaceId`. When a client sends
only `installationId`, the SDK resolves the existing Home Assistant space for
that installation even if older records preserved Home Assistant's uppercase
config-entry id in `knowledgeSpaceId`. The SDK also reads Home Assistant spaces
case-tolerantly, so existing manuals, graph nodes, links, and extraction rows
remain queryable without reuploading or migrating data.

Snapshot sync accepts Home Assistant-native object fields at the HTTP boundary.
The integration can send registry objects with snake_case identifiers such as
`entity_id`, `device_id`, `area_id`, `integration_id`, `unique_id`, and
`friendly_name`; the daemon normalizes them into the SDK's internal graph
shape before creating nodes and relations. This keeps Home Assistant-specific
wire format handling in the SDK route/service layer while preserving the
canonical graph metadata fields (`entityId`, `deviceId`, `areaId`,
`integrationId`) for stored Home Graph records.

Snapshot sync also refreshes living Home Graph pages by default, but the default
sync path is intentionally bounded. The SDK prioritizes likely real-world
devices such as TVs, locks, thermostats, cameras, routers, appliances, phones,
and other physical devices, then defers lower-value software/plugin/add-on pages
to explicit page generation, reindex, or refinement routes. This keeps Home
Assistant service calls from timing out while still making the most useful pages
available quickly after a snapshot. The sync response reports
`generated.deferredDevicePassports`, `generated.deferredRoomPages`, and
`generated.truncated` when more pages remain. Page automation also accepts
`maxRunMs`, so integrations can keep snapshot service calls responsive even
when a large installation has many pages eligible for refresh. Foreground
snapshot page generation is still capped by the SDK; callers can request lower
limits, but very large values are treated as background/deferred intent rather
than permission to block the sync route indefinitely. The knowledge store also
batches the thousands of row updates created by a real Home Assistant snapshot
and persists them once at the end of the sync instead of exporting the SQLite
database after every node and edge write.

For each selected active Home Assistant device, the SDK materializes a device
passport markdown artifact and a stable generated-page source. For each selected
active room/area, it materializes a room page. This is built on the same
generated-projection primitive used by the base knowledge/wiki system, so
generated Home Graph pages are stable sources with durable markdown artifacts
instead of temporary one-off files. Generated page markdown includes Home
Assistant identity, exposed entities, linked source evidence, extracted semantic
facts, quality issues, and open questions. Linked manuals and other sources are
converted into typed durable fact nodes before rendering; device passport pages
do not include raw source-snippet sections. Generated
page sources are marked with
`metadata.homeGraphGeneratedPage: true`, `metadata.projectionKind`, and
`metadata.pageEditable: true`; the source id stays stable across regenerations
while the artifact id points at the latest rendered markdown. If the rendered
markdown is unchanged, the SDK reuses the existing generated artifact instead of
creating a duplicate on every snapshot sync. Generated markdown artifacts are
stored durably because they back living wiki pages. Clients can retrieve the
current generated page list and markdown through
`GET /api/homeassistant/home-graph/pages`; pass `includeMarkdown=false` when a
panel needs only the page index. Clients can let page generation run
automatically, call the explicit device/room/packet endpoints to direct or
refresh generation, or pass `pageAutomation` to snapshot sync to disable or
limit automatic work:

```json
{
  "installationId": "house-1",
  "pageAutomation": {
    "enabled": true,
    "devicePassports": true,
    "roomPages": true,
    "maxDevicePassports": 100,
    "maxRoomPages": 50,
    "maxRunMs": 15000
  }
}
```

Home Graph routes return JSON errors for validation or sync failures. Clients
should treat non-2xx responses as daemon API errors and read the JSON `error`
field; they should not receive Bun fallback HTML for handled route failures.

`POST /api/homeassistant/home-graph/ingest/artifact` is not limited to JSON.
The Home Assistant integration can forward uploads through its own authenticated
frontend bridge without exposing the daemon token:

- JSON for an existing `artifactId`, daemon-local `path`, or remote `uri`.
- `multipart/form-data` with a `file` field plus `installationId`,
  `knowledgeSpaceId`, `title`, `tags`, `target`, and JSON-encoded `metadata`
  fields.
- Raw binary with `Content-Type` set to the file MIME type and metadata passed
  in query parameters or headers such as `X-GoodVibes-Filename`.

The SDK stores the upload as an artifact first and then indexes it into the
isolated Home Graph knowledge space. Large uploads share the global
`storage.artifacts.maxBytes` cap, which defaults to `512 MiB`; clients should
avoid JSON `dataBase64` for manuals, receipts, photos, and other large files.

`POST /api/homeassistant/home-graph/ask` uses a lightweight Home Graph search
state instead of loading full issue/export state. It batches extraction lookup
by source id and scores bounded fields, capped extraction sections, and
`structure.searchText` when present. Matched sources are passed through the
shared semantic enrichment layer, which extracts durable features,
capabilities, specifications, procedures, maintenance facts, warnings,
compatibility, configuration, troubleshooting notes, wiki pages, and gaps. The
answer is synthesized from those facts and source snippets by the daemon's
current LLM provider/model, with deterministic fact rendering as the fallback.
Home Graph uses the same provider-backed answer synthesis path as
`POST /api/knowledge/ask`; semantic source enrichment is allowed to continue as
self-improving background work so a question is not forced to wait behind a
full enrichment pass before answer synthesis starts. If a source matches before
typed facts have been extracted, the SDK still returns synthesized prose that
describes the currently indexed evidence and the remaining gap instead of
dumping raw snippet bullets.
When a concrete Home Assistant object is identified but the current evidence is
weak, Home Graph Ask also gets one bounded foreground repair pass. The daemon
checks already-indexed official/vendor sources, searches for up to five
high-confidence sources when needed, promotes extracted source evidence into
typed facts, and re-runs answer selection once if useful facts were created.
If the bounded pass cannot produce usable facts in time, the response still
includes `refinementTaskIds` so the panel can show ongoing repair state.
The same self-improvement loop also runs when Home Graph syncs a snapshot,
ingests a manual/document/URL/note, or reindexes. Snapshot sync schedules a
tiny delayed repair pass and does not run external web/LLM repair inline with
the Home Assistant service response. For concrete objects such as devices,
services, integrations, and providers, the SDK can create intrinsic
feature/specification gaps as soon as the object or source exists, classify
whether the gap is applicable, suppress non-applicable gaps before search, and
repair eligible gaps through source-backed web ingest from the delayed sync
pass, Ask, reindex, explicit refinement runs, or scheduled jobs. This means a
newly added device with a stable manufacturer/model can start filling missing
feature/spec knowledge without waiting for a user to ask an Assist question,
while the sync call itself stays bounded.
Repair skip checks are gap-specific: an older repair URL for the same Home
Assistant object does not block another intrinsic gap unless it is linked to
that exact gap with `repairs_gap`.
Accepted repair sources are not just remembered as URLs. The SDK re-enriches
them under the refinement budget, promotes useful extracted evidence into typed
feature/capability/specification facts, and links those fact nodes back to the
concrete Home Assistant subject with `describes` edges. Official/vendor repair
facts are preferred over weaker secondary deterministic fragments during Ask
and page generation.
Provider-backed semantic calls are bounded by SDK timeouts and abort signals,
and broad reindex uses a small LLM budget before continuing deterministically,
so Home Assistant panels should not add host-side wrappers to avoid hung provider
requests. If a source was previously enriched deterministically because no LLM
was available or the LLM budget was exhausted, the SDK can upgrade that source
during a later ask/reindex and supersede the old deterministic semantic
facts/pages instead of returning both old and new interpretations.
Repair tasks that are blocked until a retry window include top-level
`nextRepairAttemptAt` in addition to trace/metadata details, so Home Assistant
panels can show retry timing without parsing SDK trace details.
Current text, HTML, JSON, CSV/TSV, XML, YAML, DOCX, XLSX, PPTX, and PDF
extraction paths persist capped searchable text.
PDF manuals use PDF.js text-layer extraction, with a lightweight raw-stream
fallback only when the dedicated parser cannot load the file. The raw fallback
inflates Flate-compressed streams before reading literal strings and refuses to
persist binary-like stream data as `searchText`, summaries, sections, or page
content. If no readable text can be extracted, the PDF extraction fails instead
of becoming placeholder Home Graph evidence.

Ask excerpt selection scans bounded windows throughout the stored searchable
text, so a query can match a feature/spec/reset section that appears later in a
large manual instead of being limited to the first parsed chunks. This is still
bounded by the SDK search caps and does not rescan whole documents on every
question.

Older Home Graph artifact sources do not need to be uploaded again. When ask
finds a relevant linked source with missing, placeholder, or old PDF extraction
data, the SDK re-extracts the already-stored artifact and saves the
new extraction record before ranking the answer. Later questions reuse that
stored extraction instead of parsing the manual on every request. Clients that
want to repair the whole Home Assistant knowledge space immediately can call
`POST /api/homeassistant/home-graph/reindex`. Reindex reparses stale stored
artifacts, auto-links matching manuals and documents to Home Assistant devices
or entities when model/entity/source identity is strong enough, refreshes
semantic facts/pages/gaps for changed or explicitly forced sources, and
regenerates living pages only for devices affected by repaired or newly linked
evidence or an older generated-page policy. It skips generated-page artifacts,
so "reindex uploads" stays focused on user-provided/manual sources and stale
page refresh rather than treating generated pages as source material. In a
normal changed-only run, source auto-linking is limited to sources reparsed in
that run; a forced reindex can still perform a broader stored-source link
audit. The
response reports `scanned`, `reparsed`, `skipped`, `failed`, `truncated`,
`budgetExhausted`, `changedSourceCount`, `forcedSourceCount`,
`skippedGeneratedPageArtifactCount`, `refreshedGeneratedPageCount`,
`generatedPagePolicyVersion`, `coalesced`, repaired `sources`, auto-link
`linked` summaries, semantic enrichment counts, regenerated page `generated`
counts, and per-source `failures`. If another Home Graph reindex is already
running, the SDK returns `coalesced: true` quickly and leaves the active run in
charge instead of stacking another foreground scan.

If a development or early-preview Home Graph space was populated by older SDK
builds with bad source links, stale generated pages, or contaminated refinement
tasks, rebuild it through SDK routes instead of editing the SQLite database.
First call `POST /api/homeassistant/home-graph/export` and save the JSON for
diagnosis. Then call the admin-only
`POST /api/homeassistant/home-graph/reset` route with `installationId` or
`knowledgeSpaceId`. Use `dryRun: true` first to get the exact delete counts
without mutating the graph; the response includes `dryRun: true` and the same
`deleted` summary shape as the real reset, plus artifact candidate counts. A
non-dry run deletes the selected Home Assistant knowledge space rows: sources,
nodes, edges, issues, extractions, refinement tasks, job runs, usage records,
consolidation records, and schedules. It also deletes artifacts referenced by
those sources and orphan artifacts tagged to that knowledge space. Pass
`preserveArtifacts: true` only when intentionally preserving uploads for a
records-only cleanup. After reset, re-sync the real Home Assistant snapshot,
reingest or relink manuals/documents from the integration, then run
reindex/refinement/page generation against the clean space.

Ask ranking is object-aware. When a question names a Home Assistant object,
such as "the TV" or "front door sensor", the SDK matches that query to Home
Graph nodes and strongly prefers indexed sources linked to those nodes or
sources whose identity matches a physical/device anchor. For TV questions, the
source scope favors physical TV devices, `media_player` entities, and matching
model/manufacturer evidence over generic Home Assistant integrations or other
devices while ignoring noisy objects such as TV-show calendars, Plex library
sensors, automations, and Wake-on-LAN switches. Singular object questions such
as "the TV" are narrowed to the strongest matching object anchor before
candidate sources are handed to the semantic answer layer, so answers are not
blended across multiple televisions or manuals that only share broad TV/spec
tokens. Pending integration documentation candidates are source suggestions,
not answer material, until they are indexed. Device feature/spec/manual
questions require useful source evidence, so low-information extraction
placeholders, unrelated device manuals, and Home Assistant integration docs are
excluded from the answer unless the query is explicitly about the integration.
Binary-like raw PDF payloads and
other garbled extraction text are treated as unusable and repair-needed, not as
answer evidence. Answers include synthesized text, sources, linked objects,
semantic facts, and knowledge gaps when available; clients should display the
answer text, sources, facts, and linked objects returned by the SDK rather than
locally re-ranking the graph or rendering raw extraction snippets.
`linkedObjects` contains real Home Assistant graph objects only. Semantic
extraction artifacts such as generated wiki pages, fact nodes, and knowledge
gaps remain in `facts`/`gaps` and are not reported as linked HA objects.
Home Graph ask passes strict candidate ids into the shared semantic answer
layer after object-scoped ranking. That keeps answer synthesis inside the
matched Home Assistant object/source set and prevents unrelated manuals from
appearing only because they contain generic feature/specification vocabulary.
Generated semantic wiki pages and extracted fact nodes are not used as Home
Assistant object anchors, so a generated Kasa page or generic "features" fact
cannot make a TV query pull Kasa sources into the answer. Feature/spec answers
also suppress deterministic manual boilerplate such as "items may vary",
"specifications may change", "new features may be added", recommended
cable-type fragments, remote button-map noise, remote battery-low notes,
optional accessory/setup fragments, Magic Remote accessory-compatibility
snippets such as MR20GA/Bluetooth compatibility, remote infrared/sensor
instructions, generic "may not work properly" setup fragments, generic
service/repair boilerplate, and safety/cable warnings unless the user asked for
that kind of warning or compatibility detail. Truncated deterministic fragments
are dropped instead of presented as specifications. Provider-returned answer
text is also post-filtered for those low-value feature/spec fragments, so a
synthesis model cannot reintroduce boilerplate that the evidence filter already
removed. Home Graph answer synthesis runs before background semantic enrichment
so single-concurrency provider wrappers answer the user before refreshing
source semantics. Generated device passports and room pages apply the same
fact-quality filter so living pages focus on useful device capabilities,
specifications, actionable maintenance, troubleshooting, and source-backed
notes rather than generic handling/safety fragments, certified cable warnings,
remote/accessory instructions, service-only port fragments, or heading-only
manual/spec fragments.
Semantic refinement gaps such as `knowledge.answer_gap`,
`knowledge.semantic_gap`, and `knowledge.intrinsic_gap` are not rendered as
device/room page issues. They remain available through Ask gaps, review, and
refinement-task routes where clients can show repair state without mixing
backlog questions into wiki page content.
Room pages also scope open issues to the requested area and its related graph
objects. A room page does not render every open Home Graph issue in the house;
only issues attached to the room, its devices/entities/automations/scenes,
linked sources, or scoped gap nodes are eligible.

When Home Graph sync/reindex/ingest/ask can identify an object and missing
knowledge gaps, the shared semantic gap-repair layer can search the web in the
background. It scores already-indexed sources and web candidates against the HA
device/service identity, manufacturer/model hints, the gap wording, and the
query. Existing official/vendor sources count as usable repair evidence; the
SDK links and promotes them instead of blocking solely because they were already
indexed. One strong official/vendor source can close a gap, while non-official
evidence still needs corroboration across distinct domains. Repair tries
progressively more targeted queries for the exact subject and gap, then accepts
no more than five high-confidence sources for that gap. Accepted sources are
linked to the exact gap with `repairs_gap` edges and carry source-assessment
metadata with confidence, accepted/rejected reasons, search queries, gap IDs,
original source IDs, and linked HA object IDs. Accepted sources are also
semantically re-enriched under the run budget, and promoted fact nodes are
linked back to the HA object with `describes` edges. This is source-backed
graph refinement, not unsupported inference in the current response. Clients
can call reindex or ask again later to use newly indexed/promoted facts once
extraction/enrichment has finished. Existing repair sources only suppress the
specific gap they repair, not every gap attached to the same device or service.
Ask-created gaps queue refinement tasks and start repair asynchronously. Ask
does not wait for web search, URL ingest, or re-answering; it returns the
current best source-backed answer and any `refinementTaskIds` for continued
repair. The route also has an SDK-owned synthesis timeout so a slow provider
cannot hold the Home Assistant panel or daemon request open indefinitely.
Home Graph reindex also queues repairable gaps, caps foreground source
enrichment with a run budget, and starts only a small delayed background repair
pass after returning source-enrichment and queued-task metadata. Panels should
use explicit refinement runs or schedules for deeper repair work instead of
expecting reindex to search and repair the whole house inline.

Refinement is observable through a stable job-style API. The Home Assistant
panel can show what gap was detected, whether it is repairable, what source
candidates were accepted or rejected, what graph changes were applied, and
whether the task is closed, blocked, suppressed, cancelled, failed, or waiting
for review. The Home Graph wrappers are:

- `GET /api/homeassistant/home-graph/refinement/tasks`
- `GET /api/homeassistant/home-graph/refinement/tasks/{id}`
- `POST /api/homeassistant/home-graph/refinement/run`
- `POST /api/homeassistant/home-graph/refinement/tasks/{id}/cancel`

The base knowledge API exposes the same task model under
`/api/knowledge/refinement/*`. Home Graph status includes readiness signals for
`ready`, `repairing`, `needs_review`, `needs_sources`, and `empty`, plus open
issue and active refinement task counts. Panels should display those fields
instead of inferring refinement progress from reindex duration or issue totals.
The refinement run response includes `candidateGaps`, `processedGaps`,
`requestedLimit`, `effectiveLimit`, `truncated`, and `budgetExhausted`; Home
Assistant panels should show those fields when a broad run is capped or when a
short foreground budget leaves additional repair work for a later run. Stale
active tasks left behind by an interrupted daemon process are recovered as
blocked-and-retriable the next time refinement runs for that Home Graph space.
The foreground cap is currently 24 gaps per run; panels should offer repeated
or scheduled runs instead of sending one unbounded request for the whole house.
Historical `No semantic gap repairer is configured` tasks are also reopened
when the daemon starts running with a configured repairer, so the Refine tab
should not keep treating those records as current wiring failures after the
host is fixed.
Run-budget exhaustion is retryable state, not a terminal dead end. When a
repair attempt times out or runs out of foreground budget, the SDK marks the
gap `deferred`, records `nextRepairAttemptAt`, and leaves the task blocked with
retry metadata for the next scheduled/manual refinement pass. If accepted
source evidence exists but is not sufficient to close the gap, the SDK still
links/promotes that evidence and defers the task rather than throwing away the
progress.
Home Graph Ask also keeps real Home Assistant linked objects when the strongest
evidence comes from web-repaired semantic sources whose `sourceDiscovery`
metadata references the HA object. Ask source records also include `sourceId`
and `url` aliases alongside the canonical SDK source fields. Overlapping repair
and reindex runs are coalesced by the SDK, so repeated broad
Refine/Reindex/Ask-triggered calls should not stack unbounded LLM/search/source
work in the daemon.
Home Graph status reports `activeRefinementTaskCount` for running/queued work
only; detected backlog records remain visible in the refinement task list but
do not make readiness look like an active repair run.

`GET` or `POST /api/homeassistant/home-graph/map` returns the current Home Graph as visual
map data with deterministic node positions, filtered edges, and an SVG string.
It uses the shared knowledge map renderer also exposed by `GET /api/knowledge/map`,
so Home Assistant panels can rely on the same node/edge/SVG response shape as
the base knowledge/wiki map. Pass `includeSources=false` to show only graph
nodes, `limit` to cap the rendered graph, or `format=svg` to receive
`image/svg+xml` directly for an embedded preview. Self-loop edges are suppressed
at write time for snapshot object links and at render time for maps, so objects
such as integrations do not produce `connected_via` edges pointing back to
themselves.

The Home Graph map supports all generic knowledge map filters plus
Home Assistant-specific filters. Generic filters include `recordKinds`,
`nodeKinds`, `sourceTypes`, `sourceStatuses`, `nodeStatuses`, `issueCodes`,
`issueStatuses`, `issueSeverities`, `edgeRelations`, `tags`, `ids`,
`linkedToIds`, `query`, and `minConfidence`. Home Assistant filters live under
`ha` for JSON requests and include `objectKinds`, `entityIds`, `deviceIds`,
`areaIds`, `integrationIds`, `integrationDomains`, `domains`, `deviceClasses`,
and `labels`. The same HA filter names are also accepted as top-level aliases
for simpler clients. Each field is multi-select: values inside one field are ORed
together, and different fields are ANDed together. When a Home Assistant filter
matches a leaf object such as an entity domain, the SDK also keeps immediate
device, area, source, fact, and gap context edges so the map remains a graph
instead of a disconnected list of matching records.

The JSON response includes `nodes`, `edges`, `width`, `height`, `nodeCount`,
`edgeCount`, `svg`, and `facets`. Edge records include canonical `fromId` and
`toId` plus `source`, `target`, `sourceTitle`, and `targetTitle` aliases so
browser graph renderers can consume the map without remapping the SDK fields.
`facets.homeAssistant` contains the actual
areas, devices, entity domains, integrations, labels, and other Home Assistant
values present in the graph, with counts. Panels should build filter controls
from those facets and send selected filters back to the SDK; they should not
fetch the whole graph and implement graph filtering locally. The route also
accepts a trailing slash and JSON `POST` input with the same fields so panel
bridges can use either query-string or JSON dispatch without route fallback
errors.

Home Graph quality issues are generated from the current graph but review
decisions are durable. When a user or LLM resolves/rejects an issue through
`POST /api/homeassistant/home-graph/facts/review`, the SDK records review and
suppression metadata separately from the generated issue row. Future sync or
quality refreshes do not reopen that issue unless the subject fingerprint
changes. For known quality issues, semantic review values can also update the
underlying node facts:

```json
{
  "installationId": "house-1",
  "issueId": "hg-issue-...",
  "action": "reject",
  "reviewer": "homeassistant",
  "value": {
    "category": "not_applicable",
    "fact": {
      "batteryPowered": false,
      "batteryType": "none"
    },
    "reason": "This object does not use batteries."
  }
}
```

`homegraph.device.unknown_battery` applies only to plausible battery-powered
physical devices. The SDK skips integrations, add-ons, Home Assistant
host/core/supervisor/software objects, helpers, Sun/weather-only objects,
bridges, hubs, coordinators, adapters, and obvious mains-powered media or
appliance devices unless explicit metadata says the device is battery-powered.
`homegraph.device.missing_manual` is similarly limited to likely physical
devices and is suppressed by `manualRequired: false`.

Home Assistant integration snapshots can include integration documentation
metadata such as `documentation_url`, `source_url`, and `issue_tracker_url`.
The SDK also derives the standard
`https://www.home-assistant.io/integrations/<domain>/` URL for integration
nodes. These are stored as linked documentation-candidate sources in the
isolated Home Graph space. They are not fetched during snapshot sync; clients
can ingest selected candidates explicitly when full source content is needed.

Supported Home Assistant node kinds:

- `ha_home`
- `ha_entity`
- `ha_device`
- `ha_area`
- `ha_automation`
- `ha_script`
- `ha_scene`
- `ha_label`
- `ha_integration`
- `ha_room`
- `ha_device_passport`
- `ha_maintenance_item`
- `ha_troubleshooting_case`
- `ha_purchase`
- `ha_network_node`

Supported relation names:

- `controls`
- `located_in`
- `belongs_to_device`
- `has_manual`
- `has_receipt`
- `has_warranty`
- `has_issue`
- `fixed_by`
- `uses_battery`
- `connected_via`
- `part_of_network`
- `mentioned_by`
- `source_for`

The HA integration should keep graph storage transient on its side. It should
collect registry snapshots, expose services/entities/repairs, and pass stable
Home Assistant ids to the daemon. The daemon owns source provenance,
confidence/review state, materialized room/device/packet markdown, exports, and
namespace-filtered search.

Home Graph operator methods match the HTTP routes:

- `homeassistant.homeGraph.syncHomeGraph`
- `homeassistant.homeGraph.ingestHomeGraphUrl`
- `homeassistant.homeGraph.ingestHomeGraphNote`
- `homeassistant.homeGraph.ingestHomeGraphArtifact`
- `homeassistant.homeGraph.linkHomeGraphKnowledge`
- `homeassistant.homeGraph.unlinkHomeGraphKnowledge`
- `homeassistant.homeGraph.askHomeGraph`
- `homeassistant.homeGraph.refreshDevicePassport`
- `homeassistant.homeGraph.generateRoomPage`
- `homeassistant.homeGraph.generateHomeGraphPacket`
- `homeassistant.homeGraph.listHomeGraphIssues`
- `homeassistant.homeGraph.reviewHomeGraphFact`
- `homeassistant.homeGraph.map`
- `homeassistant.homeGraph.pages.list`

Additional browse/export methods are available for source inventory and future
knowledge UIs: `homeassistant.homeGraph.sources.list`,
`homeassistant.homeGraph.browse`, `homeassistant.homeGraph.export`, and
`homeassistant.homeGraph.import`.

Home Assistant prompt ingress uses isolated remote-chat sessions backed by the
same daemon chat manager used by companion-app remote chat. It does not use a
shared TUI session, `SharedSessionBroker`, `AgentManager`, or WRFC
review/fix chains.

### Home Assistant Assist Conversations

Home Assistant conversation agents should use:

```text
POST /api/homeassistant/conversation
Authorization: Bearer <daemon operator token>
```

Canonical body:

```json
{
  "message": "is the garage door open?",
  "conversationId": "assist-home",
  "messageId": "ha-assist-msg-123",
  "userId": "ha-user-id",
  "displayName": "Home Assistant",
  "context": {
    "language": "en",
    "deviceId": "voice-pe-1",
    "areaId": "garage"
  },
  "timeoutMs": 120000
}
```

The response resolves only when the isolated chat turn completes, fails, is
cancelled, or the wait timeout is reached:

```json
{
  "ok": true,
  "acknowledged": true,
  "messageId": "ha-assist-msg-123",
  "conversationId": "assist-home",
  "sessionId": "ha-chat-sess-1234",
  "routeId": "route-1234",
  "mode": "remote-chat",
  "newSession": false,
  "sessionExpired": false,
  "status": "completed",
  "assistant": {
    "text": "The garage door is closed.",
    "speechText": "The garage door is closed.",
    "status": "completed"
  }
}
```

`message`, `prompt`, `text`, `body`, or `task` can carry the prompt text.
`providerId`, `modelId`, and `tools` are optional; if omitted, daemon/session
defaults apply. Home Assistant normally does not expose provider/model
selection, so the daemon resolves the active/default routing. The isolated chat
session receives a Home Assistant system prompt and the daemon tool registry,
including `homeassistant_*` tools when the HA URL and access token are
configured.

`POST /api/homeassistant/conversation` returns the final response directly and
does not also publish a `goodvibes_message` event by default. Set
`"publishEvent": true` only when the Home Assistant integration also wants the
normal event-bus delivery for that same turn.

The daemon creates Home Assistant conversations as isolated remote-chat
sessions, not shared TUI sessions. It reuses the isolated chat session for the
same Home Assistant conversation until
`surfaces.homeassistant.remoteSessionTtlMs` elapses with no activity. The
default is 20 minutes. After TTL expiry the daemon closes the old chat session
and starts a fresh one, preventing stale Home Assistant turns from inheriting
an old, long transcript.

For an SSE transport, use:

```text
POST /api/homeassistant/conversation/stream
```

The response is `text/event-stream` with one `final` or `error` event.
`final.data.assistant.text` and `final.data.assistant.speechText` carry the
text Home Assistant should return from a `ConversationEntity`.

To cancel a running turn:

```json
POST /api/homeassistant/conversation/cancel
{
  "sessionId": "ha-chat-sess-1234"
}
```

The cancel endpoint also accepts a `messageId` while the daemon still has the
message-to-session correlation in memory.

### Home Assistant to GoodVibes Webhook

The webhook route remains available for Home Assistant service actions and
automations that cannot call authenticated daemon API routes directly:

```text
POST /webhook/homeassistant
```

Required auth header, one of:

```text
x-goodvibes-homeassistant-secret: <webhookSecret>
x-goodvibes-webhook-secret: <webhookSecret>
Authorization: Bearer <webhookSecret>
```

Canonical prompt body:

```json
{
  "type": "prompt",
  "message": "turn on the kitchen lights and explain what changed",
  "conversationId": "home",
  "deviceId": "goodvibes-daemon",
  "entityId": "sensor.goodvibes_last_message",
  "areaId": "kitchen",
  "userId": "ha-user-id",
  "displayName": "Home Assistant",
  "messageId": "ha-msg-123",
  "providerId": "openai",
  "modelId": "gpt-5.5",
  "tools": ["homeassistant_state", "homeassistant_call_service"]
}
```

`message`, `prompt`, `text`, or `task` can carry the prompt text. `providerId`,
`modelId`, and `tools` are optional; if omitted, daemon/session defaults apply.
The adapter creates or updates a route binding with
`surfaceKind: "homeassistant"`, posts the prompt through an isolated
remote-chat session, and publishes the final reply through the Home Assistant
event bus. It does not spawn an agent and does not attach to a shared TUI
session.

For Assist conversation agents, use `/api/homeassistant/conversation` so Home
Assistant can return the assistant reply directly in the conversation call. The
webhook returns an acknowledgement and delivers the final response through the
configured `goodvibes_message` event.

Control commands are supported through the same webhook:

```text
status <session-id>
cancel <session-id>
```

### GoodVibes to Home Assistant

Daemon replies and automation output are delivered to Home Assistant by firing
the configured event type through the Home Assistant REST API:

```text
POST /api/events/<surfaces.homeassistant.eventType>
Authorization: Bearer <Home Assistant long-lived access token>
```

The event payload is JSON and includes:

```json
{
  "source": "goodvibes",
  "emittedAt": "2026-04-26T00:00:00.000Z",
  "type": "message",
  "title": "GoodVibes",
  "body": "Assistant reply",
  "status": "completed",
  "sessionId": "ha-chat-sess-1",
  "routeId": "route-1",
  "surfaceId": "homeassistant",
  "externalId": "home",
  "messageId": "ha-assistant-msg-1",
  "replyToMessageId": "ha-msg-123",
  "conversationId": "home",
  "speechText": "Assistant reply",
  "metadata": {
    "threadId": "thread-1",
    "channelId": "area.kitchen",
    "inboundMessageId": "ha-msg-123",
    "conversationId": "home",
    "attachments": []
  }
}
```

The Home Assistant integration should listen for this event type and update
entities, diagnostics, notifications, or repairs from the event data. The
`replyToMessageId`, `conversationId`, `sessionId`, and `routeId` fields are
stable SDK-owned correlation fields for matching a Home Assistant service call
or webhook prompt to the final GoodVibes event.

## SDK Home Assistant Tools

The SDK exposes Home Assistant tools to operators and isolated remote-chat
turns. Side-effecting tools are intentionally explicit.

| Tool | Action | Side effects | Purpose |
|---|---|---:|---|
| `homeassistant_manifest` | `homeassistant-manifest` | no | Returns daemon/device setup contract. |
| `homeassistant_status` | `homeassistant-status` | no | Checks configured HA API reachability and token posture. |
| `homeassistant_states` | `homeassistant-list-states` | no | Lists entity states with optional `domain`, `query`, and `limit`. |
| `homeassistant_automations` | `homeassistant-list-automations` | no | Lists automation entities without requiring the model to remember the `automation` domain filter. |
| `homeassistant_state` | `homeassistant-get-state` | no | Reads one entity state. |
| `homeassistant_services` | `homeassistant-list-services` | no | Lists callable Home Assistant services. |
| `homeassistant_call_service` | `homeassistant-call-service` | yes | Calls a service such as `light.turn_on`. |
| `homeassistant_fire_event` | `homeassistant-fire-event` | yes | Fires an event on the Home Assistant event bus. |
| `homeassistant_render_template` | `homeassistant-render-template` | no | Renders a Home Assistant template. |

Operator-only Home Assistant actions also include
`homeassistant-publish-goodvibes-event`, which publishes a GoodVibes-shaped
message event to the configured Home Assistant event type. It is not exposed as
a chat tool because normal daemon replies already use the Home Assistant reply
path.

## Home Assistant Project Handoff

The Home Assistant integration should implement:

1. A `manifest.json` with `config_flow: true`.
2. A config flow that collects:
   - Daemon base URL.
   - Daemon bearer token.
   - Webhook secret.
   - Optional Home Assistant long-lived token setup guidance for enabling
     daemon-to-HA tools and event delivery.
3. A config entry and device registry entry representing the GoodVibes daemon
   as a service device.
4. Services/actions registered at integration setup time:
   - `goodvibes.prompt`
   - `goodvibes.status`
   - `goodvibes.cancel`
   - `goodvibes.call_tool`
5. A Home Assistant Assist conversation platform using `ConversationEntity`.
   Submit prompts to `POST /api/homeassistant/conversation`, pass
   `conversation_id` as `conversationId`, wait for the response, and return
   `assistant.speechText`/`assistant.text` from the entity handler.
6. Event listener for `surfaces.homeassistant.eventType`, default
   `goodvibes_message`.
7. Entities for:
   - Daemon connectivity/status.
   - Last GoodVibes reply.
   - Active Home Assistant chat session id.
   - Last error.
   - Optional tool catalog count/version.
8. Optional WebSocket or SSE client support:
   - Home Assistant can use its own WebSocket APIs internally.
   - For a GoodVibes daemon SSE transport, the integration can call
     `/api/homeassistant/conversation/stream` and consume its `final` or
     `error` event.
   - For broader daemon events, the integration can subscribe to the daemon
     control-plane event stream when it needs live updates beyond event bus
     deliveries.

Do not reimplement GoodVibes routing, tool catalogs, or provider/model
resolution in the Home Assistant project. The HA integration should consume the
SDK/daemon endpoints above and keep Home Assistant-specific UI/entity/service
logic on the HA side.
