// Empty stub module — satisfies bare-specifier imports of 'fs', 'path',
// 'node:fs', 'node:path' when esbuild bundles for the Miniflare harness.
// The SDK's ./web entry transitively references these node built-ins but
// does not call them at runtime under Workers; the stub prevents Miniflare
// from choking on bare specifiers it cannot resolve.
export default {};
