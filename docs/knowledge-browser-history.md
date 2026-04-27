# Browser Knowledge Ingestion

GoodVibes can index local browser history and bookmarks into the structured
knowledge store. This is metadata-first ingestion: it reads browser profile
databases and bookmark files, records provenance, and builds graph links without
fetching every visited URL from the network.

## Supported Inputs

- Chromium-family profiles: Chrome, Chromium, Brave, Edge, Vivaldi, Arc, Opera
- Gecko-family profiles: Firefox, Zen, LibreWolf, Waterfox, Floorp
- WebKit-family profiles: Safari, Orion, Epiphany
- Source kinds: `history` and `bookmark`

The reader copies locked SQLite databases to a temporary directory before
opening them, including `-wal` and `-shm` siblings when present. Safari and
Orion bookmark files are parsed from property lists. Non-HTTP(S) browser URLs
are ignored by the knowledge ingest path.

## Ingest Behavior

Browser entries are folded by canonical URL. If a page appears in both history
and bookmarks, the SDK writes one source with both provenance kinds instead of
creating duplicate records. The resulting source metadata includes:

- `browserSourceKinds`
- `browserKinds`
- `browserProfiles`
- `browserFolders`
- `browserObservationCount`
- `browserVisitCount`
- `browserFirstRecordedAt`
- `browserLastRecordedAt`
- `browserObservations`

For new browser-only records, the SDK creates a synthetic `browser-history`
extraction with title, summary, sections, and links. If the same canonical URL
already exists from a richer URL or artifact ingest, the SDK preserves the
existing connector, source type, artifact, content hash, and extraction, then
adds browser provenance and graph links.

The compiler links browser sources to domain nodes, profile `source_group`
nodes, bookmark folder nodes when available, and topic tags such as
`browser-history` and `browser-bookmark`.

## SDK Usage

```ts
const result = await knowledge.ingest.browserHistory({
  browsers: ['chromium', 'firefox'],
  sourceKinds: ['history', 'bookmark'],
  limit: 1000,
  sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
});
```

Equivalent service API:

```ts
const result = await knowledgeService.syncBrowserHistory({ limit: 1000 });
```

Daemon HTTP route:

```http
POST /api/knowledge/ingest/browser-history
```

The route is admin-only because it reads local browser profile data.

Background job:

```ts
await knowledge.jobs.run('knowledge-sync-browser-history', {
  mode: 'background',
  limit: 1000,
});
```

The job is built in but not scheduled by default.

## Extraction Improvements

HTML artifact extraction now tries `jsdom` plus Mozilla Readability first and
falls back to the older lightweight extractor for malformed or hostile HTML.
This improves URL and artifact ingest quality by favoring article text over
navigation chrome while leaving non-HTML extraction behavior unchanged.

## Privacy Notes

Browser history is local user data. Clients should present this as an explicit
opt-in action, show which browsers will be scanned, and disclose that the SDK
stores URL, title, timestamp, profile, folder, and visit-count metadata in the
GoodVibes knowledge database. Some platforms may require extra filesystem
permission, such as macOS Full Disk Access for Safari history.
