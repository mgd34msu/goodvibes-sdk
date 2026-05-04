# GoodVibes Bash LSP Vendor Patch

This directory vendors `bash-language-server@5.6.0` for the published SDK
package.

Upstream package:

- npm: `bash-language-server@5.6.0`
- npm tarball: `https://registry.npmjs.org/bash-language-server/-/bash-language-server-5.6.0.tgz`
- integrity (sha512): copy the `bash-language-server@5.6.0` entry from `bun.lock` when verifying
- upstream git tag: `v5.6.0` in https://github.com/bash-lsp/bash-language-server
  (run `git ls-remote https://github.com/bash-lsp/bash-language-server refs/tags/v5.6.0`
  to resolve the commit SHA at refresh time)

Refresh procedure:

```bash
TMPDIR="$(mktemp -d)"
npm pack bash-language-server@5.6.0 --pack-destination "$TMPDIR"
tar -xzf "$TMPDIR"/bash-language-server-5.6.0.tgz -C "$TMPDIR"
rsync -a --delete "$TMPDIR"/package/ vendor/bash-language-server/
node -e "const p=require('./vendor/bash-language-server/package.json'); p.dependencies.editorconfig='3.0.2'; require('fs').writeFileSync('./vendor/bash-language-server/package.json', JSON.stringify(p,null,2)+'\n')"
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

Reason:

- `bash-language-server@5.6.0` pins `editorconfig@2.0.1`.
- `editorconfig@2.0.1` pins `minimatch@10.0.1`.
- `minimatch@10.0.1` is in the vulnerable ranges for
  `GHSA-3ppc-4f35-3m26`, `GHSA-7r86-cg39-jmmj`, and
  `GHSA-23c5-xmqv-rm74`.
- `editorconfig@3.0.2` depends on `minimatch@~10.2.4`, which resolves to the
  fixed `10.2.5` line.

The runtime Bash LSP code is otherwise unchanged from the upstream npm package.
The committed `out/` JavaScript directory is intentionally retained from the
upstream published package so GoodVibes can pack and run the Bash language
server without executing the vendored package's build or publish lifecycle
scripts during SDK installation. Source map files are omitted from the vendor
copy because they are not loaded by the runtime language server.
Remove this vendor package when upstream `bash-language-server` publishes a
release that depends on a fixed `editorconfig`/`minimatch` chain.
