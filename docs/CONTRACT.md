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
| `install` | `{ ref, source?, name? }` | `{ ok: true, name, path }` |
| `update` | `{ name, path?, ref? }` | `{ ok: true, name, path, changed: boolean }` |
| `refresh` | `{}` | `{ ok: true, generatedAt }` |
| `keep` | `{ name, keep: boolean }` | `{ ok: true, name, keptAt }` |
| `cleanup` | `{ mode: "disable" \| "remove", targets: [{ name, path }] }` | `{ ok: true, mode, succeeded, failed, results: [{ name, ok, code?, message? }] }` |

`keep` writes or clears the one diagnosis decision the Host cannot derive, and is idempotent.
`cleanup` is a closed loop over the existing `set-invocation` / `remove` handlers: sequential, at
most 100 targets, always HTTP 200 for a well-formed request with one result per target, so a
read-only row degrades instead of failing the batch. A malformed request returns 400. Neither
action adds a route.

`ref` is one canonical reference, parsed once by `parseRef` (exported, pure): `<slug>` for Tencent
SkillHub and `<owner>/<repo>[@<rev>][#<path>]` for a GitHub source. `owner/repo/path/segments` is a
subpath; `.git`, a trailing `/`, and a trailing `/SKILL.md` are dropped; and
`https://github.com/<owner>/<repo>[/tree/<rev>[/<path>]]` or `/blob/<rev>/…/SKILL.md` (with optional
`http(s)://`, `www.`, or a bare `github.com/` prefix) parse to the same canonical form. A canonical
`ref` is a fixed point of `parseRef`. `install` derives the source from `ref`; an explicit `source`
that disagrees is 400 `bad-request`, and a `name` hint that contradicts the fetched `SKILL.md` name
is 422 `invalid-skill` (the skill identity is the declared name; a contradicting hint would create a
folder the catalog cannot name). `update` without a stored origin needs `ref` (the one-time link
gesture) and may carry `path`, the catalog skill file the row holds, so a skill outside the default
install root is reachable. Every update reads the source now: it bypasses the payload, tree and
commit caches an install may populate. `changed` is a byte comparison only.
New 409 codes: `name-mismatch` (a link or re-point whose source declares another skill, or a clicked
row whose file declares another name or no name), `subpath-required` (the repository holds several
skills and the reference names none), `flat-skill` (a flat `<name>.md` cannot be updated in place).

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
Online body: `{ "source": "skills-sh" | "tencent", "ref": string, "name"?: string, "file"?: string }`.
`ref` uses the same canonical grammar as `install`, so a GitHub subpath previews as
`skills-sh` with `owner/repo@rev#path`; `name` is required only when the reference names no path.
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
  `{ version: 1, skills: { "<name>": { source, ref, commit, name, version, installedAt, path } } }`.
  `commit` is the 40-hex commit the written files were read from, or `null` when the channel that
  served them could not pin one; `version` is Tencent's version string and `null` for git. The same
  record minus `path` is mirrored into `<skill>/.skill-source.json`. A record only describes the
  directory it was written for: `update` ignores a same-named record whose `path` is another
  directory.
  `discover` marks `installed` from it; `update` uses it when the caller passes no `ref`.
  `state.skills[].installed` stays exactly `{ source, ref, version, installedAt }`.
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
  bar (已安装 / 发现 / 统计 / 诊断 — `installed` / `discover` / `usage` / `diagnosis`), and the
  tab body. The body scrolls inside the panel; the page fills the main column height.
- Data: fetch `skill-dashboard/state` on mount and after every mutation; re-fetch on tab
  switch only when older than 5 s. Show an inline error banner with a retry button when a
  request fails — never a blank panel.
- Installed tab rows: skill name, description (2 lines, ellipsis), badges
  (source label, the detected coding agent, `已调用 N 次`, `只读` when not writable), a switch for
  “模型可调用” (`modelInvocable`), a secondary “/name 可调用” switch (`userInvocable`,
  disabled when `!userInvocable && !modelInvocable` is not relevant — keep both operable),
  and a row menu with 更新 / 删除 / 查看路径; a row that is writable but has no recorded origin
  offers 关联来源 instead of 更新 and opens one inline form that links the source and updates in the
  same Host call. A row with a recorded origin shows a quiet `来源 <ref>` line under its
  description (`skill.origin` / `skill.originVersion`). High usage must be visually flaggable:
  rows whose `usage.count` ≥ the panel's own 75th percentile get a subtle “高频” badge.
  The list paints in batches of 15 rows on animation frames, marks itself `aria-busy` until the
  whole filtered set is mounted, and memoizes each row, so a large library never renders in one
  blocking task. The search input value stays urgent while the filtered list reads a deferred
  value; both degrade to plain synchronous rendering when the host React lacks the API.
- The agent filter offers the detected coding agents (`runtimes`), each with its skill
  count, and hides itself when none was detected. A row badge names the agent when only
  one reads the skill (`仅 {agent}`), counts them when only some do (`{count}/{total} 个
  Agent`), and stays away when they all do.
- Discover tab: source selector (skills.sh / 腾讯), search input with Enter-to-search,
  result cards with install button and installed state, plus loading / empty / error states.
  Below the search form, one direct-install field (从 GitHub 安装) accepts the same reference
  grammar and posts `install` with no `source`; a repository is not searchable, so it is not a
  third source in the selector.
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
- `GET /skill-dashboard/state` carries a `diagnosis` block whose `skills` covers every catalog
  name exactly once, and `POST /skill-dashboard/action {"action":"cleanup",...}` disables a real
  skill and puts it back.

## 8. Skill diagnosis

Answers two questions about the whole library from the call history the Host already records:
which skills are in use, and which have gone quiet long enough to be worth cleaning up.

### 8.1 Policy

One exported constant, the only place a day threshold appears.

```js
export const DIAGNOSIS_POLICY = Object.freeze({
  activeDays: 14,  // called within the Usage tab's own window
  staleDays: 30,   // one month of silence
  watchDays: 3,    // the smallest window in which "not called" means anything
})
```

`keep` has no expiry. A keep is valid while `lastUsedAt === null || lastUsedAt <= keptAt`, so a
later call voids it without a writer.

### 8.2 Reference measuring

- `now` is captured once in `buildState` and published as `diagnosis.evaluatedAt`.
- `days(from, to) = max(0, floor((to - from) / 86_400_000))`; a backwards clock yields 0, never a
  false silence.
- `observedDays = days(since, now)` describes the store, not a skill.
- `watchedDays` is how long a call to that skill could have been observed:
  `days(firstSeenAt, now)`, where `firstSeenAt` is the persisted stamp of §8.4.

### 8.3 Verdict, bucket, and eligibility (Host only)

Verdicts, first match wins:

1. `active` — `lastUsedAt !== null && idleDays <= activeDays`
2. `kept` — a valid keep (§8.1)
3. `unknown` — `watchedDays < watchDays`
4. `unused` — `lastUsedAt === null`
5. `stale` — `idleDays >= staleDays`
6. `cooling` — otherwise

`closed` is `!modelInvocable && !userInvocable`: the skill is off both paths.

Buckets partition the catalog, in this order:

| bucket | when |
|:--|:--|
| `kept` | verdict `kept` |
| `unknown` | verdict `unknown` |
| `dormant` | `closed`, and verdict `stale` or `unused` |
| `active` | verdict `active` or `cooling` |
| `cleanup` | everything else (`stale` or `unused`, still open) |

Eligibility travels on the wire so the Client never derives it:

- `can.keep` — `verdict !== 'active'`
- `can.disable` — `writable && !closed && (verdict === 'stale' || verdict === 'unused')`
- `can.remove` — `writable && (verdict === 'stale' || verdict === 'unused')`

A read-only cleanup candidate therefore shows `只读`, offers only `保留`, and is never sent to
`cleanup`.

Ordering inside `diagnosis.skills`: bucket rank `cleanup` (0) → `dormant` (1) → `unknown` (2) →
`kept` (3) → `active` (4); inside `cleanup`, `stale` before `unused`, then `idleDays` desc then
`watchedDays` desc; inside `active`, `idleDays` asc (most recent first); ties by `compareNames`.
The Client may re-sort for display; it may not re-classify.

### 8.4 Store additions

`usage.json` stays `version: 1` and keeps every existing key. Three additive facts:

```jsonc
{
  "version": 1,
  "since": 1795000000000,                  // write-once observation epoch, 0 when unknown
  "catalog": { "code-review": 1795000000000 },  // firstSeenAt per name, never rewritten
  "skills": { "code-review": { /* … */, "keptAt": 1796000000000 } },  // keptAt only when kept
  "recent": []
}
```

- `emptyUsageStore()` returns `since: 0` and `catalog: {}`. Returning a clock here would silently
  re-date every existing store on load.
- `usageEpoch(state, now)` answers `state.since` when positive, else the oldest provable instant
  among `lastUsedAt` and the surviving day keys, else `now`. It never mutates.
- `stampUsage(usage, catalog, presence, now)` fills `since` once and stamps each unseen name.
  The stamp is `clamp(presence ?? now, since, now)`, where `presence` is the skill file's creation
  time when the platform reports one and the path exists. It returns whether anything changed;
  `buildState` schedules a flush only then.
- `keptAt` is written by `keep` and read by `diagnoseSkills`; `applyUsageEvent` must not touch it.

### 8.5 Wire

`GET /skill-dashboard/state` gains one top-level key. Nothing existing changes shape or order.

```jsonc
"diagnosis": {
  "evaluatedAt": 1796000000000,
  "since": 1795000000000,
  "observedDays": 11,
  "thresholds": { "activeDays": 14, "staleDays": 30, "watchDays": 3 },
  "counts": { "active": 10, "cleanup": 132, "dormant": 4, "kept": 2, "unknown": 2, "total": 150 },
  "skills": [
    { "name": "pdf-merge", "verdict": "stale", "bucket": "cleanup",
      "idleDays": 41, "watchedDays": 11, "lastUsedAt": 1792500000000, "useCount": 2,
      "keptAt": null, "closed": false, "writable": true,
      "can": { "disable": true, "remove": true, "keep": true } }
  ]
}
```

Rules:

- `skills` covers every name in `state.skills` exactly once; `counts.total === skills.length`.
- `idleDays` is `null` exactly when `lastUsedAt` is `null`.
- `lastUsedAt` is the raw record timestamp, so the Client formats it with the existing helper.
- `thresholds` is copy only. The Client must not branch on it.
- The block is absent on an older Host; the Client renders one "update the plugin" state.

### 8.6 Pure Host functions (exported for `node --test`)

```js
export const DIAGNOSIS_POLICY
export function usageEpoch(state, now)                       // number, never mutates
export function stampUsage(usage, catalog, presence, now)    // boolean changed
export function diagnoseSkills(catalog, usage, context)      // the §8.5 document
```

`catalog` entries carry `name`, `modelInvocable`, `userInvocable`, `writable`.
`context` is `{ now, since?, presence?, thresholds? }`. `diagnoseSkills` must not mutate its
inputs.

### 8.7 Client: the Diagnosis tab

A fourth tab after Usage. The Client computes: the selected bucket (default `cleanup`; `active`
when cleanup is empty), the search needle over names, sort, and the selection set. It renders
Host verdicts verbatim.

Structure, top to bottom:

1. `SectionHeading` with the one-line basis: judged only from calls the dashboard observed.
2. Horizon line: `观察自 {date} · {days} 天 · {total} 个技能，其中 {active} 个最近 14 天被调用过`.
3. Bucket strip, five segments carrying Host counts: 可清理 / 已停用 / 在用 / 已保留 / 观察中.
   Disabled buckets are not hidden: `观察中` and `已保留` are real answers.
4. Queue toolbar: bucket count, search with a visible label, and select-all for the rows that
   carry the bucket's action.
5. Rows: checkbox, name button opening the existing preview dialog, badges (verdict, `只读`,
   `已停用`), an evidence line built only from wire numbers, and actions in the order
   `停用` (primary, no confirmation), `删除` (inline confirmation), `保留`.
6. Sticky bulk rail while a selection exists: tally (`已选 N · 可停用 N · 可删除 N · 只读 N`),
   then `停用` / `删除` / `保留` / `清除选择`. Delete opens the same inline confirmation, naming
   the count and the first names. Nothing is sent for a row whose `can` flag is false.
7. A `判断依据` details block restating the three thresholds and that 保留 stops the reminder.
8. Empty states: nothing to clean (with the watch-window sentence), no selection, old Host,
   offline. Never a blank panel.

Bulk sends one `cleanup` request per group (disable, remove) and one `keep` request per name,
then one state read, then a receipt naming succeeded and failed counts. A failed row stays in
place carrying the Host's message.

All strings come from the dictionaries, in all four places (inline `zh`, inline `en`,
`locale/zh.json`, `locale/en.json`). Reuse existing classes and primitives; new classes keep the
`skd-` prefix; no new dependency, no build step.

### 8.8 Tests

- `test/diagnosis.test.mjs` — boundary table at 13/14 and 29/30 idle days, 2/3 watched days,
  never-called vs long-silent, keep voided by a later call, keep on a never-called skill, closed
  escalation to `dormant`, read-only `can`, counts partition, input immutability, store epoch
  derivation and one-time stamping, corrupt record tolerance.
- `test/apply.test.mjs` — the real routes: state carries the diagnosis; `keep` survives a reload;
  `cleanup` degrades per row (one read-only target beside a writable one) and reports both;
  unknown verbs still 400.
- `test/client.test.mjs` — the queue projection: bucket filtering, search, tally, and that a
  read-only row never enters a disable target list.
- No console errors from a crashed slot entry; the page reads correctly in light and dark.
