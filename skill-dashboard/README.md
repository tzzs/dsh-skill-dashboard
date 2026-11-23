# Skills Manager

A DeepSeek Harness plugin that puts every agent skill in one place. It shows what is installed, which coding agent can see each skill, how often it is called, and gives you direct switches to turn auto-invoke or manual invocation off.

It appears as **Skills Manager / 技能管理** in the Plugins page, adds a **Skills / 技能** entry to the Web UI left rail below `Plugins` and `Automation`, and opens a full page in the central column (panel id `skill-dashboard`).

## What it does

**Installed (已安装).** One ledger for every skill across all agent presets.

- Scans preset catalogs in parallel (`agentPresets` and `skills.list({ scope })`), so a skill visible to one or many presets appears once, with an installed count badge on the tab.
- Detects coding agents that read skill directories (Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Amp, Cline, Droid, Kilo Code, Kimi Code CLI, Pi, Warp, Zed, and fx) from their own skill roots, and labels each row with the agents that read it. The table mirrors the `skills` CLI registry (`vercel-labs/skills/src/agents.ts`). Canonical `.agents/skills` roots count for every agent that reads them, flat `.md` skills inside non-universal runtimes' own roots are recognized, and DSH sees every catalog skill.
- Shows source (`user-agents`, `user-dsh`, `project-*`, `custom`, `bundled`), call count, and a `Read-only` (`只读`) badge for skills inside the DSH installation (bundled skills and `app.asar` entries), which the plugin refuses to modify.
- Provides two switches per row (**Auto-invoke / 自动调用** and **`/name` manual / `/name` 手动**), each with a hover hint, and marks skills as **Disabled / 已停用** when both paths are off.
- Row menu actions include **Update / 更新** (for skills installed by this plugin), **Delete / 删除**, and **Show path / 查看路径**.
- A `Frequent` (`高频`) badge marks skills above the 75th percentile with at least three calls, so an over-eager skill stands out without opening the Usage tab.

**Discover (发现).** Install skills from two public sources proxied through the Host.

- **skills.sh.** Community skills directory indexing Git repositories. Entries install from `owner/repo` via `raw.githubusercontent.com`, with paths discovered through the GitHub tree API (cached 10 min).
- **Tencent SkillHub** (`api.skillhub.cn`). Domestic source with Chinese titles, versions, download counts, and per-file raw downloads.
- Checks installed state against the live catalog union, and renders a 6-card skeleton grid matching the result card layout while loading.
- Stages installs outside every watched skill root, then moves them into pre-resolved `$DSH_AGENTS_HOME` (usually `~/.agents/skills`) with retries so file watchers never observe a half-written skill.

**Usage (统计).** Measure real skill usage over time.

- Supports Today, last 7/14/30/60 days, or a custom inclusive date range within retained history.
- Shows period calls and active-skill counts, a searchable and sortable per-skill calls and share table, and a trend for all skills or one selected skill. Skills removed from the current library remain visible when historical usage exists, and zero-use installed skills are included.
- Search filters the table only; shares always use all calls in the selected period. Selecting a skill changes the trend without altering global period totals. Recent events and cumulative counts are labeled separately from the date range.
- Daily totals are retained for 60 days. Manual `/name` calls fall back to `'default'` when no agent preset is resolved. Model and user channel counters remain cumulative; per-day channel splits are not fabricated.
- Usage data lives in `$DSH_HOME/skill-dashboard/usage.json` and records calls observed while the plugin is enabled.

**Diagnosis (诊断).** Separate active skills from quiet ones that are ready to clean up.

- Computes one verdict per catalog skill on the Host from recorded call history. Verdicts are **In use (使用中)** for calls in the last 14 days, **Idle recently (近期未用)** for 15 to 29 days, **Unused (久未调用)** for 30 days or more with a prior call, **Never used (从未调用)**, **Kept (已保留)**, and **Observing (观察中)** when watched too briefly to judge.
- Prints the observation window explicitly (`Observed since <date> · <N> days` / `观察自 <date> · 共 <N> 天`). A skill is only marked never used after three days of observation, and a skill added after observation started gets its own shorter window.
- Partitions the catalog into five mutually exclusive buckets with Host counts: **Clean up (可清理)**, **Disabled (已停用)**, **In use (使用中)**, **Kept (已保留)**, and **Observing (观察中)**. The Diagnosis tab shows the cleanup count as a badge, and each row leads with its recorded evidence.
- Cleanup reuses the plugin's existing actions. **Disable (停用)** flips both invocation keys in one write while keeping the skill on disk, **Delete (删除)** removes the skill directory after an inline confirmation and awaits provenance persistence, and **Keep (保留)** pauses reminders until the skill is called again. Read-only skills (bundled and `app.asar`) show `Read-only` and offer Keep only.
- Select multiple rows to act on a batch. Batches degrade per row so a read-only or missing skill reports its own error while the remaining rows succeed. Delete always confirms; disable does not because it is reversible. Both `set-invocation` and `cleanup(mode: 'disable')` recompute diagnosis state atomically.
- Skills with both invocation paths disabled move into **Disabled (已停用)**, where only **Delete (删除)** remains.
- **Diagnosis rules (判断规则)** inside the tab restates the thresholds and keep rule so you can audit every verdict without reading source code.

## Skill details and file preview

Select a skill row in Installed or a result card in Discover to open its preview. On a narrow screen,
choose **Skill files** to browse the file tree. Refresh reloads the selected file if it is still available.
The dialog shows the description, source, available version and local path, an expandable
folder tree, and a reader that opens `SKILL.md` by default. Folder disclosures support native
Enter/Space operation; file labels are short while their full relative paths remain available. Markdown supports basic headings, lists,
bold text and code blocks; **阅读 / Read** and **原文 / Source** switch views. Other text
files display their source. File contents are never executed and HTML is displayed as text.

Local previews resolve only current catalog entries. Flat `.md` skills expose only their
own file; directory skills expose up to 200 regular files, scan at most 2,000 entries and
six nested levels, and exclude symlinks, VCS and dependency/cache directories. Each text
preview displays at most 128 KiB; binary/unreadable files show an explicit notice.
Local directory listings inspect metadata only, use a bounded 15-second Host cache, and
revalidate the selected file before reading. Online previews request metadata (max 40 files,
4 MiB upstream JSON fence) and only the selected text file. Known binary files are listed as
metadata without downloading their contents. Text reads stop after a 128 KiB prefix; GitHub
rate-limit fallback may expose only conventional `SKILL.md`. Installation payload limits
are unchanged. Files unavailable to the runtime cannot be previewed.

A bounded 30-second client cache reuses visited files and repeat opens. Switching files uses
`fileOnly:true`, omitting the unchanged listing. **刷新预览 / Refresh preview** bypasses
both caches; successful dashboard mutations invalidate the client cache.

The native `<dialog>` supports Escape, close button, focus return, and independent file and
content scrolling. It mounts directly to `document.body` and inherits all `--skd-*` DSH tokens.
While loading, it renders a top indeterminate progress bar along with file-tree and document
skeletons. Its desktop default is up to 1280px (92vw) wide and up to 860px (88dvh) tall. Drag
the bottom-right corner to resize, use shrink or enlarge buttons without dragging, or maximize
and restore. Normal desktop size is remembered for subsequent opens during the page lifetime.
Narrow screens (`max-width: 700px`) switch to a nearly full-screen layout. Language and theme
follow DSH while open. Host changes require restarting DSH after updating the installed plugin,
then reloading the page.

## Loading, caching, and resilience

- Initial page load renders the full DSH-native page shell (header, status pill, and 4-tab bar)
  with skeleton KPI cards, filter toolbar, and six list rows animated with
  `--dsw-alias-bg-skeleton` (disabled under `prefers-reduced-motion`).
- On the Host, `StateCache` warms up during activation, coalesces stale-while-revalidate reads
  (1.5 s TTL), and debounces `skills/change` invalidation (250 ms). Preset scans and
  `detectAgentRuntimes()` I/O run in parallel against pre-resolved install roots.
- On the client, concurrent `refresh()` calls coalesce into one request, post-mutation updates
  use the authoritative response without a blind delayed double-refetch, and background refresh
  failures keep loaded UI mounted with an inline retry banner instead of blanking the page.
- All 25 Host error codes are localized in `locale/en.json` and `locale/zh.json`, and
  user-facing copy avoids internal Host terminology.

## How "closing" a skill works

There is no separate enabled/disabled flag in DSH, and there does not need to be. The
filesystem skill provider already understands two frontmatter keys.

```yaml
---
name: code-review
description: …
disable-model-invocation: true   # hidden from the model catalog and the `skill` tool
user-invocable: false            # hidden from `/skill` gestures
---
```

The switch performs a **byte-exact frontmatter edit**.

- Turning **Auto-invoke (自动调用)** off writes `disable-model-invocation: true` (or removes the
  line when it returns to the default). Everything else in `SKILL.md` (description, nested
  `metadata`, CRLF endings) is preserved byte for byte, and turning it back on restores the
  original file (verified against 65 real skills × 3 edits, and live on `code-review` with a
  matching SHA-256).
- The provider watches its roots, so the skill leaves the model catalog at the agent's next
  `agent/pre-step`; calling `skill` for it afterwards answers
  `skill "<name>" is not available for model invocation`.
- Because the edit is a file edit, it is visible to `git diff`, survives restarts, and can be
  reverted by hand. Re-enabling never depends on this plugin being loaded.

A skill file shared by several presets affects all of them; the row's agent badge shows which
coding agents read it before you flip the switch.

## Sources and endpoints

| Source | Listing | Payload |
|:--|:--|:--|
| `skills-sh` | `GET https://skills.sh/api/search?q=…&limit=50` | `api.github.com/.../git/trees/{ref}?recursive=1` + `raw.githubusercontent.com` |
| `tencent` | `GET https://api.skillhub.cn/api/skills?page=1&pageSize=30&sortBy=score&keyword=…` | `GET /api/v1/skills/{slug}/files` + `/api/v1/skills/{slug}/file?path=…` |

Neither API sends CORS headers, which is why every registry call runs in the Host process and
the browser only talks to `/skill-dashboard/*`. Outbound requests are bounded (10 s, 4 MiB,
concurrency 4) and results are cached (search 60 s, trees and payloads 10 min). A failure is
reported as `source-unavailable` / `source-rate-limited` and the page offers the other source.

## Layout

| File | Role |
|:--|:--|
| `index.js` | Host half: `StateCache` SWR lifecycle, parallel catalog/runtime reads, frontmatter edits, usage store, registry adapters, four exact HTTP routes |
| `client.js` | Client half: rail icon, panel, tabs, skeleton loaders, preview dialog, single-pass DSH-native styles (no build step, no JSX) |
| `locale/*.json` | `meta.title` / `meta.description` for the Plugins page, UI dictionaries, and all 25 localized error codes |
| `icon.svg` | Original artwork |
| `cordis.patch.yml` | Inserts the `skill-dashboard` Host row |
| `test/*.mjs` | Offline helper, route and preview assertions; `real-skills` is a manual sweep |

Host routes (`GET /skill-dashboard/state`, `POST /skill-dashboard/action`,
`POST /skill-dashboard/discover`, `POST /skill-dashboard/preview`) all start with the connection trust fence and answer JSON;
no handler can throw into the carrier.

## Data the plugin owns

- `$DSH_HOME/skill-dashboard/usage.json` stores per-skill call counters, distinct sessions,
  60 day-buckets, recent activity, and three diagnosis facts (`since` written once when
  observation begins, `catalog` for when each skill name was first seen, and `keptAt` for
  explicit keep decisions). A corrupt or missing file reads as empty.
- `$DSH_HOME/skill-dashboard/installed.json` stores provenance for skills installed by this
  plugin, mirrored into `<skill>/.skill-source.json` so a hand-copied skill keeps its origin.
- Nothing else. The plugin never edits a skill outside the writable roots
  (`$DSH_HOME/skills`, `$DSH_AGENTS_HOME/skills`, project `.dsh/skills` / `.agents/skills`) and
  refuses bundled/`app.asar` skills with `read-only`.

## Tests

```sh
npm ci --ignore-scripts
npm run ci          # syntax checks plus offline client/helper/route/preview/period/diagnosis tests
npm run test:live   # manual integration sweep; needs real skill roots and network
```

`test/real-skills.test.mjs` depends on a local DSH install and live registries, so regular CI
does not run it.

## Notes and limits

- `skills.sh` has no version field and no detail API, so 更新 compares file contents and
  reports `changed` rather than a version bump; provenance is pinned by `ref`, not a commit SHA.
- Entries whose ref is not `owner/repo` are marked non-installable instead of failing on click.
- A **changed** update replaces the skill directory wholesale (stage, move the old tree aside,
  swap), so files the upstream no longer ships disappear and a hand-added file inside that skill
  folder would too. Put local additions outside the skill directory.
- Editing the Host half of an already installed plugin takes effect on the next app start; the
  Client half reloads with the page.
- Diagnosis judges only what the plugin observed. On a fresh install every skill reads
  **Observing (观察中)** until three days have passed; the cleanup list fills as the watch window
  grows. Deleting a cleanup candidate is never automatic, and a keep can be cleared at any time.
