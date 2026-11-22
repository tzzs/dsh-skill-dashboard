# DSH Skill Dashboard

[![CI](https://github.com/tzzs/dsh-skill-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/dsh-skill-dashboard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/tzzs/dsh-skill-dashboard)](https://github.com/tzzs/dsh-skill-dashboard/releases)

A DeepSeek Harness (DSH) plugin that puts every agent skill in one place: what is
installed, which coding agents can see it, how often it is really used, which skills are worth
keeping, and a read-only preview of the files behind it.

[中文说明](README.zh.md)

## Features

**Installed** — every skill of every agent preset in one ledger.

- Combines the per-preset catalogs, so a skill visible to two presets appears once.
- Detects the coding agents that really read skill directories — Claude Code, Codex, Cursor,
  Gemini CLI, GitHub Copilot, OpenCode and more — from their own skill roots, and labels
  each row with the agents that read it.
- Shows source, call count and a `read-only` badge for skills inside the DSH installation.
- Two switches per row (model invocation and `/name` invocation) that edit the skill's
  YAML frontmatter, plus row actions for update, delete and path.
- Search, agent and status filters, usage/name/recency sorting.

**Discover** — install skills from two public registries through the Host.

- `skills.sh` (Git repositories) and Tencent SkillHub (`api.skillhub.cn`), both proxied by
  the Host because neither API sends CORS headers.
- Installs are staged outside every watched skill root and then moved in, so the provider
  never observes a half-written skill.

**Usage** — today, last 7/14/30/60 days or a custom range.

- Per-skill calls and share, a trend for all skills or one selected skill, and a 60-day
  daily history.
- Cumulative totals and recent activity are labelled separately; search and trend selection
  never change the period totals.

**Diagnosis** — which skills are really in use, and which have gone quiet.

- One verdict per skill from the recorded calls: in use, slowing down, stale, never called,
  kept, or too new to judge. The observation window is printed on the page.
- Five buckets with counts: clean up, off, in use, kept, too new. Each row shows the evidence
  behind its verdict.
- Disable (reversible), delete (confirmed), or keep (stops the reminder) one row or a whole
  selection. A batch degrades per row, and read-only skills offer keep only.

**Preview** — click a skill name to read it.

- Collapsible folder tree, Markdown reader or raw source, binary and size-limit notices.
- On-demand loading with bounded Host and client caches, and a resizable, maximizable window.
- Contents are never executed; HTML in a skill file is shown as text.

**DSH integration** — the panel follows the Host's language, colour theme and font without a
second settings store, and keeps every control keyboard reachable.

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

`npm run ci` runs the client, helper, route, preview and usage-period suites against
temporary directories and mocked registry responses. `test:live` is intentionally excluded
from CI because it needs a real DSH installation and live registries.

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
| `skill-dashboard/index.js` | Host half: catalog, frontmatter edits, usage store, registries, four HTTP routes |
| `skill-dashboard/client.js` | Client half: panel, tabs, preview dialog, styles (no build step, no JSX) |
| `skill-dashboard/locale/*.json` | UI dictionaries and the Plugins page metadata |
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

The plugin reads the skill roots that DSH already exposes and writes only the two
frontmatter keys you toggle in the panel (or the files you explicitly delete). Its own state
lives in `$DSH_HOME/skill-dashboard/`, and registry calls are made by the Host, never by the
browser.

## License

[MIT](LICENSE) © 2026 tzzs
