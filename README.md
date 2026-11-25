# DSH Skill Dashboard

[![CI](https://github.com/tzzs/dsh-skill-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/dsh-skill-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/tzzs/dsh-skill-dashboard)](https://github.com/tzzs/dsh-skill-dashboard/releases)

A DeepSeek Harness (DSH) plugin that puts every agent skill in one place. It appears as **Skills Manager** (**Skills** in the sidebar) and shows what is installed, which coding agents can see each skill, how often it is used, which skills to clean up, and a read-only preview of its files.

[中文说明](README.zh.md)

## Features

**Installed.** One ledger for every skill across all agent presets.

- Combines per-preset catalogs so a skill visible to multiple presets appears once, with an installed count badge on the tab.
- Detects coding agents that read skill directories (including Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, and OpenCode) from their skill roots, recognizing both directory skills and flat `.md` skills in non-universal runtime roots.
- Shows source, call count, and a `Read-only` badge for skills inside the DSH installation.
- Provides two switches per row (**Auto-invoke** and **`/name` manual**) that edit the skill's YAML frontmatter, a `Disabled` state when both are off, and row actions for update, delete, and path.
- Update pulls from the recorded origin (Tencent SkillHub, skills.sh, a GitHub reference, or a well-known registry's skill archive) and swaps the skill directory atomically. A skill another tool installed can be pointed at its source once (**Link source**), then updates from it; a GitHub install records the exact commit that was written, and a skill another CLI installed is followed through its `.skill-lock.json` entry, including its renamed source folder and its archive URL.
- Supports search, agent and invocation-status filters, and usage, name, or recency sorting.

**Discover.** Install skills from two public registries or straight from GitHub, proxied through the Host process.

- Searches `skills.sh` (Git repositories) and Tencent SkillHub (`api.skillhub.cn`) on the server side because neither API sends CORS headers.
- Installs directly from GitHub with `owner/repo`, a GitHub URL, a branch/tag/commit (`owner/repo@rev`), or a subpath (`owner/repo#skills/pdf`). Files come from `raw.githubusercontent.com`; when that or the API is refused, listing and bytes fall back to jsDelivr and the record says it is unpinned.
- Checks installed status against the live skill catalog union and renders a 6-card skeleton grid while loading.
- Stages installs outside watched skill roots and moves them in atomically so file watchers never see a half-written skill.

**Usage.** Inspect activity for today, the last 7/14/30/60 days, or a custom date range.

- Displays per-skill calls and share, a trend for all skills or one selected skill, and a 60-day daily history.
- Labels cumulative totals and recent activity separately so search and trend selection never alter period totals.
- Tracks manual `/name` calls with a `'default'` agent fallback when no preset is resolved.

**Diagnosis.** Identify active skills and quiet candidates ready for cleanup.

- Assigns one verdict per skill from recorded calls (`In use`, `Idle recently`, `Unused`, `Never used`, `Kept`, or `Observing`) and displays the observation window on the page.
- Partitions the catalog into five counted buckets (`Clean up`, `Disabled`, `In use`, `Kept`, `Observing`), with a cleanup count badge on the tab and evidence on each row.
- Lets you disable (reversible), delete (confirmed), or keep (pauses reminders) a single row or a batch selection. Batches degrade per row, read-only skills offer keep only, and invocation toggles or disable cleanup recompute diagnosis state atomically.

**Preview.** Open any installed skill row or Discover card to inspect its files.

- Shows a collapsible folder tree, Markdown reader or raw source view, and binary or size-limit notices.
- Renders a top indeterminate progress bar plus file-tree and document skeletons while loading, with bounded Host and client caches in a resizable, maximizable overlay panel.
- Never executes skill files; HTML renders as plain text.

**DSH integration.** Follows DSH language, theme, and typography with zero extra configuration.

- Uses single-pass CSS bound directly to DSH `--dsw-*` and `--ds-*` tokens across both the page and the preview overlay.
- Renders the full page shell with DSH-native skeleton cards and rows on initial load, and keeps loaded data visible with an inline retry banner if a background refresh fails.
- Localizes all UI copy and all 25 service error codes in English and Chinese, with keyboard access across every control.

## Requirements

- A DSH build whose Host exposes the `webServer` and `skills` services, with the web UI.
- Node.js 20 or later to develop, test and package the plugin.

## Install

Releases attach the packaged plugin (`local-dsh-skill-dashboard-<version>.tgz`) and a
`SHA256SUMS` file. Unpack it so the package lands in the profile's module directory, then
restart DSH:

```sh
sha256sum --check SHA256SUMS
tar -xzf local-dsh-skill-dashboard-<version>.tgz --strip-components=1 \
  -C "<profile>/node_modules/@local/dsh-skill-dashboard"
```

The bundle carries `cordis.patch.yml`, which adds the `skill-dashboard` Host row
(`@local/dsh-skill-dashboard`). Restarting DSH is required for Host code; the panel itself
reloads with the page.

The package is marked `private` and is not published to npm: a release is a GitHub asset,
not a registry entry.

## Development

```sh
npm ci --prefix skill-dashboard --ignore-scripts
npm run ci --prefix skill-dashboard          # syntax checks + offline tests
npm run test:live --prefix skill-dashboard   # manual sweep: real skill roots + network
```

`npm run ci` runs the client, helper, route, preview, usage-period, and diagnosis suites
against temporary directories and mocked registry responses. `test:live` is intentionally
excluded from CI because it needs a real DSH installation and live registries.

## Documentation

| Document | Contents |
|:--|:--|
| [docs/CONTRACT.md](docs/CONTRACT.md) | Host/client contract: routes, state shape, path guards |
| [docs/UI-INTEGRATION.md](docs/UI-INTEGRATION.md) | Visual system, preview window and DSH language/theme integration |
| [docs/UI-DESIGN.md](docs/UI-DESIGN.md) | Layout, density and accessibility decisions |
| [docs/registries.md](docs/registries.md) | Verified registry and skill-root research |
| [docs/skills-internals.md](docs/skills-internals.md) | How DSH resolves skills |
| [skill-dashboard/README.md](skill-dashboard/README.md) | Plugin manual (English) |
| [skill-dashboard/README.zh.md](skill-dashboard/README.zh.md) | 插件使用说明（中文） |

## Repository layout

| Path | Role |
|:--|:--|
| `skill-dashboard/index.js` | Host half: `StateCache` SWR lifecycle, parallel catalog and runtime scans, frontmatter edits, usage store, registries, four HTTP routes |
| `skill-dashboard/client.js` | Client half: panel, tabs, skeleton loaders, preview overlay, single-pass DSH-native styles (no build step, no JSX) |
| `skill-dashboard/locale/*.json` | Bilingual UI dictionaries, localized error codes, and Plugins page metadata |
| `skill-dashboard/test/*.mjs` | Offline regression suites and the manual live sweep |
| `.github/workflows/` | CI and release automation |
| `scripts/check-release.mjs` | Release metadata consistency check |

## CI and releases

- `CI` runs on Ubuntu and Windows with Node 20, 22 and 24: offline tests, release metadata
  checks, a packed-tarball inspection, and workflow linting with a checksum-verified
  actionlint release.
- `Release please` runs after CI on a `main` push, maintains a release PR from Conventional
  Commits, and on merge creates the `vX.Y.Z` tag and GitHub release with the plugin tarball
  and `SHA256SUMS`.
- Dependabot checks the pinned workflow actions every week and groups the updates into one
  pull request with a `ci` commit prefix.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/);
release notes and version bumps are generated from them.

## Privacy

The plugin reads the skill roots that DSH already exposes and writes the two frontmatter keys
you toggle in the panel, the skills you install or update, and the files you explicitly delete.
Its own state lives in `$DSH_HOME/skill-dashboard/`, and every registry and GitHub call is made
by the Host, never by the browser. `GITHUB_TOKEN` or `GH_TOKEN` is used only when the Host
environment already carries one, to lift GitHub's anonymous rate limit.

## License

[MIT](LICENSE) © 2026 tzzs
