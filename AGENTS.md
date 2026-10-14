# Horizon Zero

`docs/` is the system spec. It is an [mdBook](https://rust-lang.github.io/mdBook/). This file only says how to keep that book current. Do not treat it as a substitute for the book.

## Keep the book in sync

When you change battle rules, accounts, instructions, matchmaking, escrow, VRF, client flows, dev mode, indexing, assets, or deployment, update the matching chapter under `docs/src/` in the same change. Update every diagram that shows the changed behavior in that same edit. A stale diagram is a wrong spec.

Ground the edit in the code. Do not document fees, races, or instructions that the program does not implement.

## Build

From the repo root:

```sh
mdbook build docs
```

`docs/book.toml` is the book config. Chapters live in `docs/src/`. The HTML output is `docs/book/`.

## Diagrams

Diagrams are mermaid fenced blocks in the chapters. mdBook 0.5 does not render them by itself. Leave them as fenced source unless `mdbook-mermaid` is on `PATH`. Only then enable the standard preprocessor and confirm `mdbook build docs` still succeeds:

```toml
[preprocessor.mermaid]
command = "mdbook-mermaid"
```

Do not add another diagram preprocessor.
