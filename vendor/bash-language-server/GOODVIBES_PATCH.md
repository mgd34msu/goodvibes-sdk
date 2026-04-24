# GoodVibes Bash LSP Vendor Patch

This directory vendors `bash-language-server@5.6.0` for the published SDK
package.

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
Remove this vendor package when upstream `bash-language-server` publishes a
release that depends on a fixed `editorconfig`/`minimatch` chain.
