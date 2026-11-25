# Skills Manager

A DeepSeek Harness plugin that puts every agent skill in one place. It shows what is installed, which coding agent can see each skill, how often it is called, and gives you direct switches to turn auto-invoke or manual invocation off.

It appears as **Skills Manager / 技能管理** in the Plugins page, adds a **Skills / 技能** entry to the Web UI left rail below `Plugins` and `Automation`, and opens a full page in the central column (panel id `skill-dashboard`).

## What it does

**Installed (已安装).** One ledger for every skill across all agent presets.

- Scans preset catalogs in parallel (`agentPresets` and `skills.list({ scope })`), so a skill visible to one or many presets appears once, with an installed count badge on the tab.
- Detects coding agents that read skill directories (Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Amp, Cline, Droid, Kilo Code, Kimi Code CLI, Pi, Warp, Zed, and fx) from their own skill roots, and labels each row with the agents that read it. The table mirrors the `skills` CLI registry (`vercel-labs/skills/src/agents.ts`). Canonical `.agents/skills` roots count for every agent that reads them, flat `.md` skills inside non-universal runtimes' own roots are recognized, and DSH sees every catalog skill.
- Shows source (`user-agents`, `user-dsh`, `project-*`, `custom`, `bundled`), call count, and a `Read-only` (`只读`) badge for skills inside the DSH installation (bundled skills and `app.asar` entries), which the plugin refuses to modify.
- Provides two switches per row (**Auto-invoke / 自动调用** and **`/name` manual / `/name` 手动**), each with a hover hint, and marks skills as **Disabled / 已停用** when both paths are off.
- Row menu actions include **Update / 更新**, **Delete / 删除**, and **Show path / 查看路径**. A writable row with no recorded origin offers **Link source / 关联来源** instead: one reference (`multi-search-engine`, `owner/repo`, `owner/repo@branch#path`, or a GitHub URL) links the skill to its source and updates it in the same call. A tracked row shows a quiet `From <ref>` line under its description; an archive URL reads as its host plus the archived skill name, with the full URL in the tooltip.
- A `Frequent` (`高频`) badge marks skills above the 75th percentile with at least three calls, so an over-eager skill stands out without opening the Usage tab.

**Discover (发现).** Install skills from two public sources or directly from GitHub, proxied through the Host.

- **skills.sh.** Community skills directory indexing Git repositories. Entries install from `owner/repo` via `raw.githubusercontent.com`, with paths discovered through the GitHub tree API (cached 10 min).
- **Tencent SkillHub** (`api.skillhub.cn`). Domestic source with Chinese titles, versions, download counts, and per-file raw downloads.
- **Install from GitHub (从 GitHub 安装).** A direct reference field under the search form: `owner/repo`, `owner/repo@rev`, `owner/repo#skills/pdf`, a `/tree/<rev>/<path>` URL, or a `/blob/…/SKILL.md` URL. A repository holding several skills with no named path answers `subpath-required` with the candidates instead of guessing, and the installed record pins the exact commit the files came from.
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
- Update checks are on by default and read-only. The first successful load runs one background
  check in chunks of four tracked skills (`check-updates`, 6 s per skill), reuses a recorded
  result for six hours unless the user refreshes, and shares the 10-minute repository caches
  across the skills of one repo; an archive source caches its download per URL for the same ten
  minutes. One chunk may take a cold tree warm plus four bounded reads, so it alone gets a 25 s
  request fence while every other route stays at 10 s; a chunk that still fails restarts the walk
  once from the first skill without a record, and a second failure leaves `检查中断` in the bar
  with the verdicts already on disk still shown. The installed tab gains an “N updates available”
  banner with Update all (N), which applies the whole available set sequentially and shows
  row-by-row progress, a Common only (M) button for the available skills you have actually
  called, and Later. An Auto-update switch stores `{ enabled, names }` in `localStorage`: choose
  the skills in the inline picker (a checkbox list with select all, clear, and done, closed by
  Escape) and each finished check applies just those, with its own receipt; nothing else is ever
  touched automatically. Checking never writes a skill tree or provenance; an older Host without
  the action simply shows no update affordance.
- The installed list paints 15 rows per animation frame with `aria-busy` until it is complete, and
  each row is memoized, so a large skill library never renders in one blocking task. The search
  input updates urgently while the filtered list reads a deferred value.
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
| `skills-sh` | `GET https://skills.sh/api/search?q=…&limit=50`, or a reference typed into Install from GitHub | `api.github.com/.../git/trees/{rev}?recursive=1` + `raw.githubusercontent.com`, with `data.jsdelivr.com` listing and `cdn.jsdelivr.net` bytes as the fallback |
| `tencent` | `GET https://api.skillhub.cn/api/skills?page=1&pageSize=30&sortBy=score&keyword=…` | `GET /api/v1/skills/{slug}/files` + `/api/v1/skills/{slug}/file?path=…` |
| `well-known` | none: the lock file records one archive URL per skill | `GET <sourceUrl>`, one gzipped tar unpacked in the Host |

A `well-known` registry (Lark's `open.feishu.cn` publishes its skills this way) offers no search
and no file listing, so this source is never shown in Discover; it only follows the archive URL a
`.skill-lock.json` entry records. One download is capped at 8 MiB declared or streamed and
decompresses to at most 32 MiB of tar; the reader scans at most 200 entries, keeps only regular
text files with safe relative paths, and the usual 40-file / 1 MiB payload limits still apply.

Neither registry API sends CORS headers, which is why every registry call runs in the Host process
and the browser only talks to `/skill-dashboard/*`. Outbound requests are bounded (10 s, 4 MiB,
concurrency 4) and results are cached (search 60 s, commits 60 s, trees and payloads 10 min), and an update always
reads the source fresh instead of reusing those caches. A
failure is reported as `source-unavailable` / `source-rate-limited` and the page offers the other
source.

GitHub commits come from `api.github.com/repos/{o}/{r}/commits`, with the repository's
`/commits/<rev>.atom` feed as a quota-free fallback; a 40-hex `rev` is its own pin and costs no
request. `GITHUB_TOKEN` / `GH_TOKEN` is sent when the Host environment already has one.

## Layout

| File | Role |
|:--|:--|
| `index.js` | Host half: `StateCache` SWR lifecycle, parallel catalog/runtime reads, frontmatter edits, usage store, registry adapters, four exact HTTP routes |
| `client.js` | Client half: rail icon, panel, tabs, skeleton loaders, preview dialog, single-pass DSH-native styles (no build step, no JSX) |
| `locale/*.json` | `meta.title` / `meta.description` for the Plugins page, UI dictionaries, and all 25 localized error codes |
| `icon.svg` | Original artwork: transparent 36×36, drawn onto the host's tile so light and dark themes both match |
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
- `$DSH_HOME/skill-dashboard/installed.json` stores provenance for every skill this plugin
  installed or linked: `{ source, ref, commit, name, version, installedAt, path }`, mirrored into
  `<skill>/.skill-source.json` (without `path`) so a hand-copied skill keeps its origin. A record
  only describes the directory it was written for; a same-named skill elsewhere is unaffected.
  Skills the skills CLI installed carry no such record, so the panel also reads
  `$DSH_AGENTS_HOME/.skill-lock.json` read-only, for 5 seconds at a time, and reports the entry as
  `{ source: "github", ref }` when the lock's `skillPath` matches `<installRoot>/<name>`. The lock
  key is the installed name, so the folder it records may differ from it (ten taste-skill entries
  install under names their folders do not carry) and several entries may share one folder; a
  `well-known` entry reports `{ source: "well-known", ref: <sourceUrl> }` instead.
- `$DSH_HOME/skill-dashboard/updates.json` caches the last check per skill:
  `{ version: 1, skills: { "<name>": { available, changedPaths, checkedAt } | { error, checkedAt } } }`.
  A result is trusted for six hours; a successful update clears that skill's record.
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

- A GitHub install records the 40-hex commit its files came from in `installed.json` and
  `.skill-source.json`. An update re-fetches the tracked reference and compares bytes, so
  `changed` is always a real comparison; when only the jsDelivr fallback served the bytes, the
  record says `commit: null` rather than guessing a pin.
- An update never renames a skill: if the source's `SKILL.md` declares another name, the call
  answers `name-mismatch` and writes nothing. Remove and install again for an upstream rename. A
  flat `<name>.md` skill answers `flat-skill`, and a repository with several skills and no named
  path answers `subpath-required` with up to five candidates.
- `skills.sh` has no version field and no detail API, so an update from a discovered card
  compares file contents and reports `changed` rather than a version bump.
- A `well-known` update downloads the skill's whole archive, unpacks the text files it holds, and
  compares them the same way. It records `commit: null` because a tarball has no commit, and a file
  the archive no longer ships is dropped from the skill directory on the same wholesale swap.
- A **changed** update replaces the skill directory wholesale (stage, move the old tree aside,
  swap), so files the upstream no longer ships disappear and a hand-added file inside that skill
  folder would too. Put local additions outside the skill directory. The same means a hand-edited
  `SKILL.md` is replaced; an unchanged upstream transfer rewrites only the provenance.
- Editing the Host half of an already installed plugin takes effect on the next app start; the
  Client half reloads with the page.
- Diagnosis judges only what the plugin observed. On a fresh install every skill reads
  **Observing (观察中)** until three days have passed; the cleanup list fills as the watch window
  grows. Deleting a cleanup candidate is never automatic, and a keep can be cleared at any time.
