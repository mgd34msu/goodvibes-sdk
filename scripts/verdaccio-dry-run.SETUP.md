# Verdaccio Dry-Run CI Setup

## DevDependency to add

Add to root `package.json` → `devDependencies`:

```json
"verdaccio": "^6.5.2"
```

Then run `bun install`.

## CI Job YAML snippet

Add this job to `.github/workflows/ci.yml` (or a dedicated `verdaccio.yml` workflow).
It should run after the `build` job succeeds.

```yaml
  verdaccio-dry-run:
    name: Verdaccio dry-run publish
    runs-on: ubuntu-latest
    timeout-minutes: 15
    needs: [build]   # adjust to match your actual build job name
    steps:
      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd

      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
        with:
          bun-version: "1.3.10"

      - name: Setup Node (for npm publish + node smoke test)
        uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f
        with:
          node-version: '22'

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build SDK
        run: bun run build

      - name: Verdaccio dry-run publish + smoke test
        run: bun run release:verify:verdaccio
```

### Notes

- The job requires `build` to have run first so `dist/` exists for packaging.
- `bun install --frozen-lockfile` ensures `verdaccio` devDep is installed.
- `node` is needed because the smoke script runs `node smoke.mjs` (ESM with bare
  specifier resolution against a freshly installed `node_modules/`).
- Adjust `needs:` to match the actual build job name in your workflow.
- The script self-cleans all tmp dirs and the Verdaccio process on both success
  and failure — no manual teardown step needed.
- The repo overrides Verdaccio's legacy `@cypress/request -> uuid@8` dry-run
  path to the checked-in `vendor/uuid-cjs` shim. Keep the root `package.json`
  override in place until Verdaccio drops that transitive dependency.
