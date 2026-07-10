# Capability bundles & SHA-pinned distribution

A **capability bundle** is a distributable unit (plugin, skill, hook-pack, or
policy-pack) that declares — up front, in a manifest — exactly which
capabilities it needs. The runtime grants a bundle **only** what it declared:
deny-by-default at the surface level, not merely at the security-capability
level. Distribution is **SHA-256 pinned**, and the marketplace index format is
**governed by construction** — an unpinned or capability-opaque entry cannot be
represented.

Import from `@pellux/goodvibes-sdk/platform/runtime/ecosystem`.

## The manifest

```jsonc
{
  "schemaVersion": 1,
  "id": "my-bundle",
  "name": "My Bundle",
  "version": "1.0.0",
  "description": "What it does.",
  "kind": "plugin",
  "capabilities": {
    "runtime": ["register.tool", "filesystem.read"],  // deny-by-default security caps
    "tools": ["my.tool"],                              // tool ids it registers
    "hooks": ["session:start"],                        // runtime hooks it subscribes to
    "configDomains": ["my"],                           // config domains it reads
    "channels": ["tui"]                                // channel surfaces it touches
  }
}
```

`validateCapabilityBundleManifest(value)` returns the typed manifest or the full
list of reasons it was rejected. An unknown security capability is a hard error,
not a silent drop — a typo cannot slip past review.

## Enforcement — declaration is the grant

`createBundleCapabilityGuard(manifest)` returns a deny-by-default guard. Every
runtime registration path calls `enforceBundleCapability(guard, surface, name)`
before honoring a bundle's request; anything the manifest did not declare throws
`BundleCapabilityViolation`.

```ts
const guard = createBundleCapabilityGuard(manifest);
enforceBundleCapability(guard, 'tool', 'my.tool');   // ok — declared
enforceBundleCapability(guard, 'channel', 'slack');  // throws — not declared
```

## Quarantine on install

`planBundleActivation(manifest, { trustTier })` resolves the bundle's declared
security capabilities against the trust tier using the existing plugin
capability model. If the bundle declared high-risk capabilities the tier does
not grant, it activates **quarantined** — those capabilities are withheld and
recorded (`plan.quarantine`), and the returned guard cannot exercise them even
though they were declared. Safe capabilities still work; over-reach is withheld,
not silently granted.

## SHA-256 pinned distribution

A pinned source carries a required `sha256`:

```ts
const source: PinnedBundleSource = {
  kind: 'file' | 'url' | 'git',
  location: '…',
  sha256: '<64 hex chars>',   // required
  ref: 'v1.0.0',              // required for git
};
const { bytes } = await fetchAndVerifyBundle(source);
```

`fetchAndVerifyBundle` verifies the pin **before** returning. A missing or
mismatched pin throws `BundlePinRefusal` — there is no path that yields bytes for
an unverified source. All three source kinds resolve to the same byte space, so
one pin convention (hex SHA-256 of the fetched bytes) governs every source.

## Governed marketplace index

A `PinnedMarketplaceIndex` is a static, self-hostable JSON document. Each entry's
`source.sha256` and `capabilities` summary are **required by the type** —
`parseMarketplaceIndex` rejects any entry missing them, so a registry built from
this format cannot list an unpinned or capability-opaque bundle. There is no
field to omit that would let one through.

```ts
const entry = buildMarketplaceIndexEntry(manifest, source);
const doc = serializeMarketplaceIndex({ version: 1, bundles: [entry] });
```

## CLI

```
bun scripts/plugin-bundle.ts init --id my-bundle --kind plugin --out bundle.json
bun scripts/plugin-bundle.ts validate --manifest bundle.json
bun scripts/plugin-bundle.ts validate --index marketplace.json
```

Both subcommands are thin front-ends over the exported library functions, so
every behavior is also callable programmatically.
