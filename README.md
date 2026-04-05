# discorpus

A monorepo for versioned scrapes of Discord client & webpack builds

## What It Is

`discorpus` is a local-first monorepo for scraping, storing, and organizing shipped Discord client builds and related webpack-delivered app code into a versioned local corpus.

Current focus:
- windows desktop installs first
- all release channels: `stable`, `ptb`, `canary`
- client build scraping
- asar extraction
- sqlite-backed browsing of scraped snapshots

The repo is designed around four core ideas:

- keep raw shipped builds and scrape outputs
- keep derived metadata queryable without rescanning the original source every time
- make human readable, prettified build code easily accessible & easy to navigate
- design & utilise custom tooling to reduce repetitive tasks and minimise manual bookkeeping

## Current Status

Implemented today:
- windows desktop install discovery by channel
- hashed desktop build scraping
- raw blob persistence
- sqlite indexing
- snapshot browsing
- archive browsing
- artifact search
- latest snapshot diffing
- extraction of `resources/app.asar`
- extraction of module asars such as `discord_desktop_core/core.asar`

## Future Plans

- Add real webpack and web-app scraping so the corpus can track Discord’s browser-delivered app code alongside shipped desktop builds.
- Expand build scraping beyond the current Windows focus so the project can capture and compare Discord builds across more operating systems and packaging targets over time.
- Build a normalization pipeline for extracted JavaScript and related assets, including prettification and stable normalized scrape versions that are easier to browse and diff over time.
- Expand diffing beyond raw file changes so the tool can surface more meaningful changes inside extracted client code, module payloads, and future web snapshots.
- Keep extending the corpus model so desktop, web, and any later targets can share the same versioning, storage, and inspection workflow instead of growing into separate one-off tools.
