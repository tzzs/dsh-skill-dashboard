# Skill Dashboard — build contract

Long-lived DSH plugin bundle that adds a **Skill dashboard** entry to the DSH Web UI left
rail (`sidebar.panellist`, beside the shipped Plugins and Automation-tasks entries) and a
full central panel (`main`, key `skill-dashboard`).

Everything below is decided; builders implement it and do not renegotiate it. If something
here is impossible, report it to the Lead instead of silently deviating.

## 1. Package layout and file ownership

Bundle root: `E:\workspaces\dsh-skills-dashboard\skill-dashboard\`

| File | Owner | Notes |
|:--|:--|:--|
| `package.json` | Lead | manifest, `dsh.bundle.patch` + `dsh.client` |
| `cordis.patch.yml` | Lead | inserts the Host row |
| `index.js` | **host-builder** | Host half: catalog reads/writes, usage store, registry install, HTTP routes |
| `client.js` | **ui-builder** | Client half: sidebar icon + main panel |
| `locale/en.json` | **ui-builder** | `meta.title` / `meta.description` + all UI strings |
| `locale/zh.json` | **ui-builder** | same keys, Chinese |
| `icon.svg` | **ui-builder** | original artwork, 64×64 viewBox, ≤256 KiB |
| `docs/*` | researchers / Lead | not shipped |

Package name: `@local/dsh-skill-dashboard`. Client factory id must equal the package name.

## 2. Runtime environment facts (verified)

- Installed DSH: `<install>/resources/app.asar/dsh`. Sidebar panel ids
  already taken: `plugins` (order 0), `schedules` (order 10). Use a fresh id.
- User skills live in `$DSH_AGENTS_HOME/skills/<name>/SKILL.md` (source label
  `user-agents`, usually `~/.agents/skills`) and optionally `$DSH_HOME/skills`
  (`user-dsh`). Project roots: `<projectRoot>/.dsh/skills`, `<projectRoot>/.agents/skills`.
  Bundled skills resolve from inside `app.asar` (read-only). A skill is either
  `<root>/<name>/SKILL.md` or a flat `<root>/<name>.md`; discovery is one level deep.
- **Disabling is native frontmatter.** `disable-model-invocation: true` keeps a skill out of
  the model catalog and out of the `skill` loader tool; `user-invocable: false` keeps it out
  of `/name` commands. Both live in the `SKILL.md` YAML frontmatter and are honoured
  immediately (the filesystem provider watches roots and invalidates its catalog).
  This is the whole "close a skill" mechanism: do not invent another one.
- Host services available for `ctx.get(...)`: `skills`, `agentPresets`, `agents`, `tools`,
  `webServer`, `connection`, `fs`, `session`, `sessions`.
- `skills.list({ scope?, cwd? })` returns `SkillSummary[]`:
  `{ name, description, whenToUse?, invocation:{modelInvocable,userInvocable}, source,
     provider, path?, resourceBase?, rank? }`.
- `agentPresets.list()` → presets with `id` (and a title-ish field); `agentPresets.acquireScope(id)`
  → `{ key } & AsyncDisposable`; pass `key` as `skills.list({ scope: key })`.
- Tool usage is observable on the Host event `'tools/result'(exec, result)` where
  `exec.name` is the tool name, `exec.arguments` is the parsed input object, and
  `exec.agent?.id` is the calling SessionId (map it to a preset with
  `agentPresets.presetForSession(session)` if that resolves; otherwise record the SessionId).
  A skill load is `exec.name === 'skill'` with `exec.arguments.name === '<skill name>'`
  and a non-error result. `'skills/change'()` fires when the catalog changed.

## 3. Transport: Client ⇄ Host

No generated Remote namespace is available to a plain-JS bundle. Use **exact HTTP routes on
the Host** plus same-origin `fetch` from the Client — the pattern proven by the installed
`dsh-idle-power` plugin (`<profile>/node_modules/dsh-idle-power/`).

Host: `ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/skill-dashboard/state', handler }), label)`
and the same for the other two paths. Every handler starts with the trust fence:

```js
function rejected (req, res) {
  const connection = ctx.get('connection')
  const rejection = connection === undefined ? undefined : connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}
```

Client: `fetch('skill-dashboard/state')` — a **relative** path, no leading slash.

Read `dsh-idle-power/index.js` and `client.js` for the surrounding mechanics (bounded body
read, `sendJson`, JSON content-type check, 10 s fetch abort). Do not copy its power-management
logic.

## 4. Host HTTP API (exact)

All responses are `application/json`. Failures use a nonzero HTTP status and
`{ ok: false, code: string, message: string }`.

### `GET /skill-dashboard/state`

```jsonc
{
  "ok": true,
  "generatedAt": 1763000000000,
  "agents": [
    { "id": "default", "title": "Default", "description": "...", "isDefault": true }
  ],
  "runtimes": [
    { "id": "claude-code", "title": "Claude Code", "skillCount": 1 },
    { "id": "dsh", "title": "DSH", "skillCount": 42 }
  ],
  "skills": [
    {
      "name": "code-review",
      "description": "…",
      "whenToUse": "…",                     // optional
      "source": "user-agents",              // SkillSummary.source verbatim
      "provider": "filesystem",
      "path": "C:\\Users\\you\\.agents\\skills\\code-review\\SKILL.md",
      "dir": "C:\\Users\\you\\.agents\\skills\\code-review",  // null for flat .md skills
      "agents": ["default"],                // agent ids whose catalog resolves this skill
      "runtimes": ["claude-code", "dsh"],   // coding agents that read this skill
      "modelInvocable": false,              // resolved: false if disabled for the model
      "userInvocable": true,
      "writable": true,                     // dashboard may edit this file
      "usage": {
        "count": 12,
        "sessions": 4,
        "lastUsedAt": 1763000000000,        // null when never used
        "days": [0,1,0,3,0,0,2,0,0,5,0,1,0,0]   // 14 buckets, oldest → today
      }
    }
  ],
  "usage": {
    "totalCount": 42,
    "activeSkills": 9,
    "dayBuckets": [{ "date": "2026-11-04", "count": 3 }],   // 14 entries, oldest → today
    "recent": [{ "name": "code-review", "at": 1763000000000, "agentId": "default" }], // newest first, max 20
    "retentionDays": 60,
    "history": [{ "date": "2026-09-20", "count": 0 }], // 60 entries, oldest → today
    "skillUsage": [{ "name": "code-review", "count": 12, "byModel": 10, "byUser": 2,
      "lastUsedAt": 1763000000000,
      "dayBuckets": [{ "date": "2026-09-20", "count": 0 }] }] // 60 entries per recorded name, including names outside catalog
  },
  "sources": [
    { "id": "skills-sh", "title": "skills.sh", "status": "ready", "note": null },
    { "id": "tencent",  "title": "腾讯 Skill 源", "status": "ready", "note": null }
  ]
}
```

Rules:
- `skills` is the union over all agents by `name`; per-agent differences collapse into
  `agents`, and a name wins the summary of its highest-ranked resolution.
- `agents` is the DSH **preset** dimension and stays as it was: usage records are keyed by
  preset, and the bundled catalog comes from the preset-scoped reads.
- `runtimes` is the independent **coding agent** dimension: the real agents (Claude Code,
  Codex, Cursor, …) that read skill directories on this machine, detected from their own
  skill roots. Only agents with at least one skill are listed, in registry order, `dsh`
  last. The registry mirrors `vercel-labs/skills/src/agents.ts`.
- `skills[].runtimes` lists the agents that read that skill and always contains `dsh`. A
  universal agent (one that reads the canonical `.agents/skills` roots) sees a skill whose
  resolved directory lies inside a canonical root; a non-universal agent only sees a skill
  that resolves to an entry of its own root. Every path is resolved first, so a broken
  junction claims nothing. A flat `.md` skill is never claimed by a non-universal agent.
- The detection is cached for 30 seconds and invalidated together with the state cache.
- `writable` is true only when `path` is a real file outside the DSH installation, i.e.
  reachable and not under `app.asar`.
- Sort by `usage.count` desc, then `name` asc.
- Existing 14-day `skills[].usage.days` / `usage.dayBuckets` remain compatible.
  `usage.history` and `usage.skillUsage[].dayBuckets` expose 60 dated daily totals.
  These use Host-local date keys; the Client selects inclusive bounds without UTC shifts.
  Per-period counts use these buckets, not `recent` (max 20) or all-time counters.
  Cumulative `count`/`byModel`/`byUser` survive pruning; historical per-day channel splits
  were not recorded and must not be inferred. A current catalog name with no stored record
  is shown as zero-use; historical names outside the catalog retain their recorded usage.

### `POST /skill-dashboard/action`

Body: `{ "action": "<name>", ... }`, `content-type: application/json`.

| action | body | success result |
|:--|:--|:--|
| `set-invocation` | `{ path, modelInvocable?: boolean, userInvocable?: boolean }` | `{ ok: true, skill: <state.skills entry> }` |
| `remove` | `{ name, path }` | `{ ok: true, removed: ["<abs path or dir>"] }` |
| `install` | `{ source, ref, name? }` | `{ ok: true, name, path }` |
| `update` | `{ source, ref, name }` | `{ ok: true, name, path, changed: boolean }` |
| `refresh` | `{}` | `{ ok: true, generatedAt }` |

`set-invocation` rewrites only the two frontmatter keys in the existing `SKILL.md`
(or flat `<name>.md`), preserving every other line byte-for-byte; when a key must be
removed it removes that line. `remove` deletes the whole skill directory (or the flat
file) after verifying the resolved path is inside a known writable skill root.
Refuse `install`/`update`/`remove` for `writable: false` with `code: 'read-only'`.

### `POST /skill-dashboard/discover`

Body: `{ "source": "skills-sh" | "tencent", "query": string, "limit"?: number }`.

```jsonc
{ "ok": true, "source": "skills-sh", "items": [
  { "id": "owner/repo/skill", "ref": "owner/repo", "name": "skill", "description": "…",
    "source": "skills-sh", "version": "1.2.0", "updatedAt": "2026-10-01",
    "url": "https://github.com/…", "installed": false }
] }
```

Network failures return `{ ok: false, code: 'source-unavailable', message }` with
HTTP 502; the Client shows the message and offers the other source. Never let a slow
external request hang the route: bound it (~10 s) and honour the request abort signal.

### `POST /skill-dashboard/preview`

Installed body: `{ "path": "<exact catalog skill path>", "file"?: "references/guide.md" }`.
Online body: `{ "source": "skills-sh" | "tencent", "ref": string, "name": string, "file"?: string }`.
The omitted file defaults to `SKILL.md`, or the flat skill filename. Both body forms also
accept `fileOnly?: boolean` and `refresh?: boolean`. `fileOnly:true` returns `ok`, `skill`,
and `file` while omitting `files`/`truncatedFiles`; the Client merges its prior listing.
`refresh:true` bypasses preview caches and requests fresh metadata/content.

```jsonc
{
  "ok": true,
  "skill": { "name": "demo", "description": "…", "source": "custom", "path": "…/SKILL.md", "version": null, "readonly": false, "agents": ["default"], "runtimes": ["dsh"] },
  "files": [{ "path": "SKILL.md", "size": 350, "kind": "text" }],
  "file": { "path": "SKILL.md", "size": 350, "kind": "text", "content": "…", "truncated": false },
  "truncatedFiles": false
}
```

`kind` is `text`, `binary`, or `unavailable`; non-text content is `null`.
Preview is read-only and never stages, installs or executes content. Same trust, method,
JSON and request-abort fences as other routes. Local paths must exactly match the current
merged catalog; file paths must be safe relative paths. Flat skills never expose siblings.
Directory previews exclude symlinks and VCS/dependency/cache folders; limit 200 files,
2,000 scanned entries and six nested levels. Read at most 128 KiB of UTF-8 per selected file.
List/file caps are explicit through `truncatedFiles` and `file.truncated`.
Local listing is metadata-only (no content sniff per listed file). Host listings are cached
15 seconds / max 32 entries with root/main identity checks; selected file containment is
revalidated on every read. Client contents are cached 30 seconds / max six skills and eight
files per skill; explicit refresh bypasses both, successful mutations clear the client cache.
Online preview fetches up to 40 file metadata records and only the selected text file.
Known binary files are metadata-only; unknown types are classified on selected-file read.
Upstream metadata keeps the 4 MiB JSON fence; selected streams retain at most 128 KiB+1
bytes and cancel unread content. `size` uses upstream metadata/Content-Length when known,
or is an observed lower bound for an oversized stream of unknown length. GitHub rate-limit
fallback exposes only conventional `SKILL.md`, marked `truncatedFiles:true`.
Existing install adapters and their 40-file / 1 MiB payload limits are unchanged.
Errors include `bad-request` (400), `skill-not-found` / `file-not-found` (404),
`preview-unavailable` (403/404) and upstream `source-unavailable` / `source-rate-limited` (502).

## 5. Host behavior

- **Usage store** — JSON at `$DSH_HOME/skill-dashboard/usage.json`, shape
  `{ version: 1, skills: { "<name>": { count, sessions: [sessionId…(cap 200)], lastUsedAt, days: {"YYYY-MM-DD": n} } }, recent: [ {name, at, agentId} ] }`.
  Keep 60 day-buckets; derive the 14-day windows in the response. Write with a debounced
  flush (≤1 s) and `mkdir -p`. A corrupt file must not crash the plugin: start empty.
- **Provenance store** — same directory, `installed.json`:
  `{ version: 1, skills: { "<name>": { source, ref, version, installedAt, path } } }`.
  `discover` marks `installed` from it; `update` uses it when the caller passes no `ref`.
- **Usage listener** — `ctx.on('tools/result', (exec, result) => …)`; ignore cases where
  `exec.name !== 'skill'`, the skill name is missing, or `result.isError === true`.
- **Invalidation** — after a pull/write/delete, the filesystem provider's watcher refreshes
  its catalog on its own. Use `ctx.get('fs')` (writeText/readText/deleteFile/list) when it is
  present so the provider invalidates synchronously, and fall back to `node:fs/promises`.
- `export const inject = ['webServer', 'skills']`; read optional services with `ctx.get`.
- Never throw out of a route handler: convert to a JSON failure response.

## 6. Client behavior

Registrations (verified against the shipped Schedule panel, `@deepseek-ai/dsh-client-ui-schedule`):

```js
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main', key: 'skill-dashboard', locale: NS,
}, SkillDashboardPage))

ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist', id: 'skill-dashboard', order: 20, locale: NS,
  label: () => t('panel.label'),
}, SkillDashboardIcon))
```

- `inject: ['slots', 'locale']`; `SkillDashboardIcon({ size, active })` renders an inline
  SVG that inherits `currentColor` (`stroke="currentColor"`), no text.
- Panel layout: a title row (title + subtitle + agent filter chips + refresh button), a tab
  bar (已安装 / 发现 / 统计 — `installed` / `discover` / `usage`), and the tab body. The body
  scrolls inside the panel; the page fills the main column height.
- Data: fetch `skill-dashboard/state` on mount and after every mutation; re-fetch on tab
  switch only when older than 5 s. Show an inline error banner with a retry button when a
  request fails — never a blank panel.
- Installed tab rows: skill name, description (2 lines, ellipsis), badges
  (source label, the detected coding agent, `已调用 N 次`, `只读` when not writable), a switch for
  “模型可调用” (`modelInvocable`), a secondary “/name 可调用” switch (`userInvocable`,
  disabled when `!userInvocable && !modelInvocable` is not relevant — keep both operable),
  and a row menu with 更新 / 删除 / 查看路径. High usage must be visually flaggable:
  rows whose `usage.count` ≥ the panel's own 75th percentile get a subtle “高频” badge.
- The agent filter offers the detected coding agents (`runtimes`), each with its skill
  count, and hides itself when none was detected. A row badge names the agent when only
  one reads the skill (`仅 {agent}`), counts them when only some do (`{count}/{total} 个
  Agent`), and stays away when they all do.
- Discover tab: source selector (skills.sh / 腾讯), search input with Enter-to-search,
  result cards with install button and installed state, plus loading / empty / error states.
- Usage tab: summary cards (总调用, 活跃技能, 今日调用), a 14-day bar chart, and the recent
  activity list. The chart is plain divs sized from the data — no chart library.
- Every visible string comes from the locale dictionaries. Use only `--dsw-alias-*` theme
  tokens for colors, borders, surfaces, text and focus rings; no literal colors, no
  `!important` overrides of host selectors, no `document.body` writes.
- Load styles once through the module's `styles.insert(css)` builtin (it is cleaned up with
  the client run) and prefix every class with `skd-`.
- Do not `require` any `@deepseek-ai/*` package.
- Factories stay side-effect free; all subscriptions/timers are created inside `apply`
  with `ctx.effect`.

## 7. Definition of done

- `node --check index.js` and `node --check client.js` pass; the manifest parses.
- `plugin_manager` `install_bundle` on the directory reports `application: applied`.
- Host rows appear via `cordis_inspect_query` (Config.listConfigs / live entries), and the
  Client slot registrations appear via `Slots.listSubTree` with root `main` (key
  `skill-dashboard`) and root `sidebar.panellist` (id `skill-dashboard`).
- `GET /skill-dashboard/state` returns the real ~150 user skills, and
  `POST /skill-dashboard/action {"action":"set-invocation",...}` flips a real skill's
  frontmatter and puts it back.
- No console errors from a crashed slot entry; the page reads correctly in light and dark.
