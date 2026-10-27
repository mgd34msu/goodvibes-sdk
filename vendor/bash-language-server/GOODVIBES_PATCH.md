# GoodVibes Bash LSP Vendor Patch

This directory vendors `bash-language-server@5.6.0` for the published SDK
package.

Upstream package:

- npm: `bash-language-server@5.6.0`
- npm tarball: `https://registry.npmjs.org/bash-language-server/-/bash-language-server-5.6.0.tgz`
- upstream tarball integrity (sha512): recorded as `goodvibesPatch.sourceIntegrity`
  in this directory's `package.json`; verify against the npm registry before refreshing
- upstream git tag: `server-5.6.0` in https://github.com/bash-lsp/bash-language-server
  (run `git ls-remote https://github.com/bash-lsp/bash-language-server 'refs/tags/server-5.6.0^{}'`
  to resolve the commit SHA at refresh time). The source used for the Zod migration
  is commit `2fb9b33b6f40b508bf3b54233ff4efef0cb08206`.

Extract upstream inputs (this is not a complete refresh; reapply the patches below):

```bash
TMPDIR="$(mktemp -d)"
npm pack --ignore-scripts bash-language-server@5.6.0 --pack-destination "$TMPDIR"
tar -xzf "$TMPDIR"/bash-language-server-5.6.0.tgz -C "$TMPDIR"
rsync -a --delete "$TMPDIR"/package/ vendor/bash-language-server/
node -e "const p=require('./vendor/bash-language-server/package.json'); p.dependencies.editorconfig='3.0.2'; p.dependencies.zod='4.6.6'; require('fs').writeFileSync('./vendor/bash-language-server/package.json', JSON.stringify(p,null,2)+'\n')"
find vendor/bash-language-server/out -name '*.js.map' -exec rm -f {} +
rm -rf "$TMPDIR"
```

`.js.map` files:

- All `out/**/*.js.map` source map files have been deleted from this vendor copy
  (the refresh snippet above already includes `find vendor/bash-language-server/out -name '*.js.map' -delete`).
- Source maps are not loaded by the runtime language server and are not needed at install time.
- They are intentionally omitted to reduce package size.

Patch:

- `dependencies.editorconfig` is changed from `2.0.1` to `3.0.2`.
- `dependencies.zod` is migrated from `3.24.2` to exact `4.6.6` for
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
- `out/config.js` uses `.prefault({})` for the `shfmt` object. Zod 4's
  `.default({})` returns the empty object without parsing, whereas the former
  Zod 3 behavior filled every nested default. `.prefault` preserves that
  behavior, including the default formatter executable.
- `out/config.d.ts` and `out/shellcheck/types.d.ts` are regenerated from
  upstream `server/src/config.ts` (with that one `.prefault` change) and
  `server/src/shellcheck/types.ts`, using TypeScript 6.0.3 and Zod 4.6.6.
  Exported schemas and inferred configuration/diagnostic types remain intact;
  the obsolete Zod 3 generic parameters and `ZodEffects` are not retained.

After extracting a fresh upstream tarball, reapply these runtime/declaration
changes and retain the GoodVibes manifest metadata and lifecycle removal.
The manifest-only refresh command above is not the complete Zod migration.

Validate with:

```bash
bun scripts/test.ts test/lsp-bash-zod-compat.test.ts test/lsp-bash-bundled.test.ts
bun run pack:check
bun run install:smoke
```

The schema regression covers defaults, preprocessing, rejected configuration,
ShellCheck diagnostics/replacements, and the fixed early rejection of bounded
collections. The separate LSP test performs the real server startup handshake.
The upstream fix is not a general limit for unbounded arrays: application
request/body limits and explicit schema collection bounds remain necessary.

Reason:

- `bash-language-server@5.6.0` pins `editorconfig@2.0.1`.
- `editorconfig@2.0.1` pins `minimatch@10.0.1`.
- `minimatch@10.0.1` is in the vulnerable ranges for
  `GHSA-3ppc-4f35-3m26`, `GHSA-7r86-cg39-jmmj`, and
  `GHSA-23c5-xmqv-rm74`.
- `editorconfig@3.0.2` depends on `minimatch@~10.2.4`, which resolves to the
  fixed `10.2.5` line.

Apart from the nested-default migration above, runtime Bash LSP code is
unchanged from the upstream npm package.
The committed `out/` JavaScript directory is intentionally retained from the
upstream published package so GoodVibes can pack and run the Bash language
server without executing the vendored package's build or publish lifecycle
scripts during SDK installation. Source map files are omitted from the vendor
copy because they are not loaded by the runtime language server.
Remove this vendor package when upstream `bash-language-server` publishes a
release that depends on a fixed `editorconfig`/`minimatch` chain and patched
Zod, with compatible configuration and ShellCheck behavior.
