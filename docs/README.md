# `docs/` — keeping the docs in sync

This folder contains the human-facing HTML documentation for `night-worcoon-3`
**plus** a tiny machinery so a future LLM session (or human) can answer
"are these docs still accurate?" in seconds, without rereading every page.

## For humans

Open [`docs/index.html`](index.html) in a browser. There's no build step.
Pages are static HTML with one shared CSS file (`assets/style.css`) and a
~10-line JS file that highlights the current page in the sidebar.

## For an LLM updating the codebase

> **TL;DR**
>
> ```bash
> node docs/check-docs.mjs            # see what changed
> # …edit any flagged docs/*.html…
> node docs/check-docs.mjs --update   # refresh hashes
> ```

Every documented source file is tracked in [`MANIFEST.json`](MANIFEST.json).
Each entry has:

- `sha256` of the file at the time the docs were last refreshed
- `lines` count
- `covers`: which doc page(s) describe this source file
- `summary`: a one-line reminder of what's in there

`check-docs.mjs` recomputes the hash of every tracked file and reports any
drift, **grouped by the doc pages affected**. Example output when nothing has
changed:

```
  ✓ Docs are in sync. No tracked source file has changed.
```

Example output after editing `plugins/mock.js`:

```
  ⚠  1 tracked source file(s) have changed since the docs were last refreshed:

    • plugins/mock.js
        was: f58f928f07ed…  (98 lines)
        now: 1c4a82be3f9b…  (104 lines)
        covered by: docs/plugins.html, docs/configs.html

  Likely-stale doc pages (review these, update if needed):

    - docs/plugins.html
        because: plugins/mock.js
    - docs/configs.html
        because: plugins/mock.js
```

### Recommended workflow

1. **Before** you start editing source files, run `node docs/check-docs.mjs`
   to confirm the docs are currently in sync (no drift). If they aren't,
   the previous session left work undone — fix that first.
2. Make your code changes.
3. Run `node docs/check-docs.mjs` again. Look at the "Likely-stale doc pages"
   list.
4. Open each listed `docs/*.html`. Use the `summary` field in
   `MANIFEST.json` for a quick reminder of what that file is about, then
   read the actual diff to decide whether the doc text needs updating.
5. **If you added a new file that should be documented**, add an entry for
   it under `sources` in `MANIFEST.json` (any `sha256` value works as a
   placeholder — the next `--update` will fix it) and reference it from the
   appropriate doc page.
6. Once the affected pages are updated, run
   `node docs/check-docs.mjs --update`. This rewrites `MANIFEST.json` with
   the current hashes. Commit the manifest along with your doc changes.

### What `check-docs.mjs` does *not* do

- It does **not** prove a doc page is actually correct — only that the
  source it covers hasn't drifted. A doc page can be stale even when the
  hash matches (e.g. someone edited the doc itself badly). Use your eyes.
- It does not detect newly added source files. If you add
  `src/foo.js`, it won't show up unless you list it in `MANIFEST.json`.
- It does not crawl the HTML. Doc-to-source mapping is whatever
  `MANIFEST.json` says.

### Output formats

```bash
node docs/check-docs.mjs           # human-readable, exit 1 on drift
node docs/check-docs.mjs --json    # JSON, exit 1 on drift
node docs/check-docs.mjs --update  # rewrite MANIFEST.json, exit 0
```

## Adding a new doc page

1. Copy any existing page (e.g. `tui.html`) as a starting point — they all
   share the same sidebar, header, and footer structure.
2. Add a link to the new page in **every** sidebar (search for
   `<aside class="sidebar">` and update them all). The pages are static —
   there's no template engine — so this is a deliberate trade-off for
   zero-build simplicity.
3. Add the new page under `docs` in `MANIFEST.json` with a one-line description.
4. Add the page name to the `covers` arrays of any source files it documents.

## Why no build step?

The repo is small (~2.5k LOC of source). Static HTML with one CSS file is
the lowest-friction way to ship docs that work offline, render on GitHub
Pages with zero config, and never drift due to a stale build artefact. The
manifest + check script is the only "build-like" piece, and it's pure Node
with no dependencies.
