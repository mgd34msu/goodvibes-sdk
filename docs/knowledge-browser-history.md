# Browser knowledge ingestion

GoodVibes can index local browser history and bookmarks into the structured
knowledge store. This is metadata-first ingestion: it reads browser profile
databases and bookmark files, records provenance, and builds graph links without
fetching every visited URL from the network.

## Supported inputs

- Chromium-family profiles: Chrome, Chromium, Brave, Edge, Vivaldi, Arc, Opera
- Gecko-family profiles: Firefox, Zen, LibreWolf, Waterfox, Floorp
- WebKit-family profiles: Safari, Orion, Epiphany
- Source kinds: `history` and `bookmark`

The reader copies locked SQLite databases to a temporary directory before
opening them, including `-wal` and `-shm` siblings when present. Safari and
Orion bookmark files are parsed from property lists. Non-HTTP(S) browser URLs
are ignored by the knowledge ingest path.

## Ingest behavior

Browser entries are folded by canonical URL. If a page appears in both history
and bookmarks, the SDK writes one source with both provenance kinds instead of
creating duplicate records. The resulting source metadata carries the folded
provenance so later reads can tell exactly where a URL was seen.

| Metadata field | What it records |
| --- | --- |
| `browserSourceKinds` | Whether the URL came from history, bookmarks, or both |
| `browserKinds` | Which browsers contributed entries |
| `browserProfiles` | Which browser profiles the entries came from |
| `browserFolders` | Bookmark folders the URL was filed under |
| `browserObservationCount` | How many raw entries folded into this source |
| `browserVisitCount` | Total visit count across the folded entries |
| `browserFirstRecordedAt` / `browserLastRecordedAt` | The earliest and latest times the URL was recorded |
| `browserObservations` | Up to 32 per-entry records with source kind, browser, family, profile, and title |

For new browser-only records, the SDK creates a synthetic `browser-history`
extraction with title, summary, sections, and links. If the same canonical URL
already exists from a richer URL or artifact ingest, the SDK preserves the
existing connector, source type, artifact, content hash, and extraction, then
adds browser provenance and graph links.

The compiler links browser sources to domain nodes, profile `source_group`
nodes, bookmark folder nodes when available, and topic tags such as
`browser-history` and `browser-bookmark`.

## SDK usage

```ts
const result = await knowledge.ingest.browserHistory({
  browsers: ['chromium', 'firefox'],
  sourceKinds: ['history', 'bookmark'],
  limit: 1000,
  sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
});
```

The `browsers` filter selects specific browser kinds (`BrowserKnowledgeKind`),
not whole families. `'chromium'` is both a family name and a discrete kind, so
`browsers: ['chromium', 'firefox']` matches only the Chromium and Firefox apps.
To target an entire family, list its kinds explicitly, for example the whole
Chromium family as
`['chrome', 'chromium', 'brave', 'edge', 'vivaldi', 'arc', 'opera']`.

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

## Extraction improvements

HTML artifact extraction now tries `jsdom` plus Mozilla Readability first and
falls back to the older lightweight extractor for malformed or hostile HTML.
This improves URL and artifact ingest quality by favoring article text over
navigation chrome while leaving non-HTML extraction behavior unchanged.

## Privacy notes

Browser history is local user data. Clients should present this as an explicit
opt-in action, show which browsers will be scanned, and disclose that the SDK
stores URL, title, timestamp, profile, folder, and visit-count metadata in the
GoodVibes knowledge database. Some platforms may require extra filesystem
permission, such as macOS Full Disk Access for Safari history.

## See also

- [Knowledge system](./knowledge.md): data model, ingestion paths, and operator surface
- [Knowledge refinement](./knowledge-refinement.md): how gaps detected from ingested sources get repaired
