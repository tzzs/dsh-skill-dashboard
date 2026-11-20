# Skill dashboard

A DeepSeek Harness plugin that puts every Agent skill in one place: what is installed, which
Agent preset can see it, how often the model actually calls it — and one switch that takes an
over-used skill away from the model again.

It adds a **技能看板 / Skill dashboard** entry to the Web UI's left rail, directly below
`插件` and `自动化任务`, and a full page in the central column (panel id `skill-dashboard`).

## What it does

**已安装 (Installed)** — every skill of every Agent preset, in one ledger.

- Reads the catalog per preset (`agentPresets` + `skills.list({ scope })`), so a skill that only
  one preset can see is listed once with `N 个 Agent`, not duplicated.
- Shows source (`user-agents`, `user-dsh`, `project-*`, `custom`, `bundled`), call count and a
  `只读` badge for skills inside the DSH installation (bundled skills and `app.asar` entries),
  which the dashboard refuses to modify.
- Two switches per row: **模型可调用** and **`/name` 可调用**.
- Row menu: **更新** (only when the dashboard installed the skill), **删除**, **查看路径**.
- A `高频` badge marks the skills above the panel's own 75th percentile with at least three
  calls, so an over-eager skill is visible without opening the statistics tab.

**发现 (Discover)** — install from two public sources, proxied through the Host.

- **skills.sh** — the community skills directory; it indexes Git repositories, so an entry is
  installed from `owner/repo` via `raw.githubusercontent.com`, path discovered through the
  GitHub tree API (cached 10 min).
- **腾讯 SkillHub** (`api.skillhub.cn`) — the domestic source; Chinese titles, versions,
  download counts, and per-file raw downloads.
- Installs are staged outside every watched skill root, then moved into
  `$DSH_AGENTS_HOME` (usually `~/.agents/skills`) with retries, so the provider's file watcher
  never sees a half-written skill.

**统计 (Statistics)** — what is actually being used.

- Choose Today, last 7/14/30/60 days, or a custom inclusive date range within retained history.
- See period calls and active-skill counts, a searchable/sortable per-skill calls/share table,
  and a trend for all skills or a selected skill. Names absent from the current library remain
  visible when historical usage exists; installed zero-use skills are included too.
- Search filters the table; shares always use all calls in the selected period. Selecting a
  skill changes the trend, not the global period totals. Recent events and cumulative counts
  are explicitly labelled as independent of the date range.
- Daily totals are retained for 60 days. Model/user channel counters remain cumulative;
  historical per-day channel splits were never stored and are not fabricated.
- The store remains `$DSH_HOME/skill-dashboard/usage.json`; only calls observed while the
  dashboard is enabled are recorded.

## Skill details and file preview

Click a skill name in Installed or Discover to open its preview. On a narrow screen,
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

The native modal supports Escape, close button, focus return and independent file/content
scrolling. Its desktop default is wider (up to 1440px, 94vw) and taller (92dvh). Drag the
bottom-right corner to resize, use shrink/enlarge buttons without dragging, or maximize
and restore. Normal desktop size is remembered for subsequent opens during the page lifetime.
Narrow screens use a nearly full-screen layout. Language and theme follow DSH while open.
Host changes require restarting DSH after updating the installed plugin, then reloading the page.

## How "closing" a skill works

There is no separate enabled/disabled flag in DSH, and there does not need to be: the
filesystem skill provider already understands two frontmatter keys.

```yaml
---
name: code-review
description: …
disable-model-invocation: true   # hidden from the model catalog and the `skill` tool
user-invocable: false            # hidden from `/skill` gestures
---
```

So the switch is a **byte-exact frontmatter edit**, nothing more:

- Turning 模型可调用 off writes `disable-model-invocation: true` (or removes the line when it
  returns to the default). Everything else in `SKILL.md` — description, nested `metadata`,
  CRLF endings — is preserved byte for byte, and turning it back on restores the original file
  (verified against 65 real skills × 3 edits, and live on `code-review` with a matching SHA-256).
- The provider watches its roots, so the skill leaves the model catalog at the agent's next
  `agent/pre-step`; calling `skill` for it afterwards answers
  `skill "<name>" is not available for model invocation`.
- Because the edit is a file edit, it is visible to `git diff`, survives restarts, and can be
  reverted by hand. Re-enabling never depends on this plugin being loaded.

A skill file shared by several presets affects all of them; the row's `N 个 Agent` badge shows
the blast radius before you flip the switch.

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
| `index.js` | Host half: catalog reads/writes, usage store, registry adapters, four exact HTTP routes |
| `client.js` | Client half: rail icon, panel, tabs, styles (no build step, no JSX) |
| `locale/*.json` | `meta.title` / `meta.description` for the Plugins page, plus the UI dictionaries |
| `icon.svg` | Original artwork |
| `cordis.patch.yml` | Inserts the `skill-dashboard` Host row |
| `test/*.mjs` | Offline helper, route and preview assertions; `real-skills` is a manual sweep |

Host routes (`GET /skill-dashboard/state`, `POST /skill-dashboard/action`,
`POST /skill-dashboard/discover`, `POST /skill-dashboard/preview`) all start with the connection trust fence and answer JSON;
no handler can throw into the carrier.

## Data the plugin owns

- `$DSH_HOME/skill-dashboard/usage.json` — per-skill call counters, distinct sessions,
  60 day-buckets, recent activity. Corrupt or missing reads as empty.
- `$DSH_HOME/skill-dashboard/installed.json` — provenance of skills this dashboard installed,
  mirrored into `<skill>/.skill-source.json` so a hand-copied skill keeps its origin.
- Nothing else. The dashboard never edits a skill outside the writable roots
  (`$DSH_HOME/skills`, `$DSH_AGENTS_HOME/skills`, project `.dsh/skills` / `.agents/skills`) and
  refuses bundled/`app.asar` skills with `read-only`.

## Tests

```sh
npm ci --ignore-scripts
npm run ci          # syntax checks plus offline client/helper/route/preview/period tests
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
