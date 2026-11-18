# Skills internals in the installed DSH (0.2.2-rc.1)

Evidence base: the installed asar at `D:\apps\DeepSeek Harness\resources\app.asar\dsh\`, read with the
`read` tool (line numbers below are that file's line numbers), plus host Inspect providers
(`Service`, `Event`, `Config`, `Tool`). Where the report says VERIFIED it was read in shipped code.
"UNVERIFIED" marks a claim I could not check.

Packages involved: `@deepseek-ai/dsh-skill` (registry service `skills`), `dsh-skill-filesystem`
(provider `filesystem`), `dsh-tool-skill` (the `skill` tool + session catalog), `dsh-tools` (`guard`),
`dsh-api-session-controller` (`sessionSkillCatalog` → `ctx.remote.skills`), `dsh-agent-preset-registry`.

Shipped composition (VERIFIED): `dsh-skill` is a **host-level** row (base bundle
`.../dsh-base/cordis.patch.yml:312`), while **`skill-filesystem` and `tool-skill` are mounted per agent
preset** (`.../dsh-web-app/presets/standard.patch.yml:40-43`). Default preset is `standard`
(`.../dsh-web-app/cordis.patch.yml:590-593`). This layering fact decides Q3.

---

## 1. Storage: roots, layout, precedence

Provider class `FileSystemSkillProvider` (`dsh-skill-filesystem/lib/index.js:62`), roots built in
`roots(cwd)` (`:160`), ranks at `:20-24`.

| Rank | source | path | notes |
|---|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` | only when `includeDefaultRoots && cwd` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` | |
| 300 | `custom` | each of `Config.customSkillDirs` | |
| 400 | `user-dsh` | `<dshHome>/skills` | `skipSystem: true` (skips a `.system` child) |
| 500 | `user-agents` | `<agentsHome>/skills` | |
| 600 | `bundled` | `Config.bundledSkillDir` ?? `$DSH_BUNDLED_SKILL_DIR` | only when `includeDefaultRoots` or set explicitly |
| 250 | *runtime* | `ctx.skills.register()` | `RUNTIME_RANK`, `dsh-skill/lib/index.js:21` |

- `projectRoot` = nearest ancestor containing `.git`, else the cwd (`findProjectRoot`,
  `dsh-skill-filesystem/lib/index.js:821`).
- `dshHome` = `$DSH_HOME` or `~/.dsh`; `agentsHome` = `$DSH_AGENTS_HOME` or `~/.agents`
  (`resolveDshHome`/`resolveAgentsHome`). On this machine: `~/.dsh/skills` **does not exist**,
  `~/.agents/skills` holds **135** skill directories (user-agents).
- Discovery is **one level deep only** (`discoverRoot`, `:595`): a directory bundle `<name>/SKILL.md`
  or a flat file `<name>.md` directly under a root. Nested `**/SKILL.md` is deliberately ignored.

On-disk layout (VERIFIED, `parseSkillFile` `:678`, `parseFrontmatter` `:794`,
`parseInvocationPolicy` `:863`): YAML frontmatter delimited by a first line exactly `---` and a closing
`---` line, then the body (`parsed.body.trim()` becomes `content`).

```markdown
---
name: my-skill                  # required, /^[a-z0-9]+(?:-[a-z0-9]+)*$/ (dsh-skill/lib/index.js:17)
description: One-line routing text.   # required, non-empty
whenToUse: optional string            # optional; provider metadata, NOT rendered by the catalog
metadata: { anything: true }          # optional object -> SkillSummary.metadata (definition only)
disable-model-invocation: true        # optional; hides from model catalog + `skill` tool
user-invocable: false                 # optional; hides from `/name` gestures + `ctx.remote.skills`
---
body...
```
Booleans accept YAML bools plus `true/false`, `yes/no`, `on/off`, `1/0` (`frontmatterBoolean`, `:877`);
an unparsable value **drops the whole skill with a warning**. Legacy keys `disableModelInvocation`,
`modelInvocable`, `userInvocable` are **rejected** (`rejectLegacyInvocationKey`, `:874`).
Symlinks are followed; `path` in the summary is the realpath, `resourceBase` is `{kind:'directory', path}`
= the bundle dir, or the *root* dir for a flat `<name>.md`.

Precedence (VERIFIED, `dsh-skill/lib/index.js`):
1. Layers: a read merges the global layer then the viewing scope's ancestor chain, farthest→nearest,
   writing into one `Map` by name (`collectFresh` `:298`; `ScopedLayers.chainLayers`/`merge`,
   `dsh-scope/lib/index.js:162,177`). **The nearest layer wins outright; no field merge.**
2. Inside one layer: `rank` → provider registration order → provider-local order
   (`compareIndexedCandidates` `:519`). Losers are logged and hidden
   (`skill "<n>" from <source> ignored because a higher-priority skill already exists`, `:320`).
3. Same-name runtime registrations in one layer are first-wins with a warning (`:197`).
4. `list()` returns summaries sorted by name; discovery is per-provider sequential.

## 2. Per-agent scoping: enumerating "preset → skills"

`skills` is a `host + per-scope` layered registry: `registerProvider`/`register` file into the **calling
context's** layer (`SkillRegistry.registerProvider` `dsh-skill/lib/index.js:147`, `register` `:193`, both
via `layers.effect(this.ctx,…)` → `scopeOf(ctx)`, `dsh-scope/lib/index.js:189,312`). A plugin mounted by a
preset's standing composition registers into **that preset's generation layer**
(`dsh-agent-preset-registry/lib/index.js:511-521`: `createScope(this.owner, key)` → children load in
`scope.ctx`). Read = `list|snapshot({ scope, cwd, signal })`.

**Supported enumeration pattern — yes, this is exactly what shipped code does** (`sessionSkillCatalog.list`,
`dsh-api-session-controller/lib/types/skill-catalog.js:116-199`):

```js
const rosters = await ctx.agentPresets.list()            // [{ id, name?, description?, order?, broken? }]
for (const row of rosters) {
  const lease = await ctx.agentPresets.acquireScope(row.id)   // { key: ScopeKey } & AsyncDisposable
  try {
    const skills = await ctx.skills.list({ scope: lease.key, cwd })   // SkillSummary[]
  } finally { await lease[Symbol.asyncDispose]() }
}
```
- Prefer `ctx.get('agentPresets')`; an unknown/broken preset throws `agent-preset/not-found` / `invalid`
  (`:648-668`), and the shipped service simply falls back to the global registry.
- For a **live** agent use the agent itself as the scope key (`{ scope: agent }`) and prefer
  `agentPresets.serviceFor(agent, 'skills')` — a preset may isolate its own `skills` service
  (`skill-catalog.js:152-155`). `ctx.agents.get(sessionId)` tells you live vs cold.
- **Scope-key lifetime:** the key is a bare `object` identity. It is valid only while its lease is held —
  `acquireScope` increments `generation.users` (`:791`), the disposer decrements and, for a *retired*
  generation with zero users, disposes the scope (`collect`, `:561-565`). Never cache a `ScopeKey`.
- `mount(ctx, id)` binds an **Agent context** to the current preset revision (`:702`); `composeFrom`
  joins a child agent to its parent's exact revision (`:717`); `recompose(ctx, id)` rebinds a *blank*
  agent (`:750`, used by `select`). All three are Agent-lifecycle calls — irrelevant for a dashboard.
- Cold sessions still record their preset: `SessionHeader.agentPreset`, plus the durable
  `agent-preset/selected` event.

## 3. Disabling one skill without deleting it (decision-critical)

### What the shipped code actually allows

There is **no** enabled/disabled flag, frontmatter key, or config field for a single skill.
`dsh-skill` Config = `collectCacheMaxEntries` only (`:120`); `dsh-skill-filesystem` Config =
`providerName, includeDefaultRoots, dshHome, agentsHome, customSkillDirs, watch, watch*,
bundledSkillDir` (`:30-43`); `dsh-tool-skill` Config = `catalogDescriptionMaxLength` only (`:777`).

Catalog visibility is decided in exactly one place (`dsh-tool-skill/lib/index.js:931-964`):
the pre-step listener snapshots `ctx.skills.snapshot({cwd, scope: agent})`, and
`snapshot.skills.filter(isModelInvocable)` becomes the catalog — **but only if the tool is still visible**:
`ctx.tools.get(skillTool.name, agent) === skillTool` (`:935`). `skills.get()` itself never checks the
invocation policy (`dsh-skill/lib/index.js:250-264`), so a disable must be enforced at a surface boundary.

The tool refuses a policy-blocked skill with a fixed message (`dsh-tool-skill/lib/index.js:866-885`):

```js
if (!isSkillName(args.name)) throw new Error(`invalid skill name "${args.name}"`);
const summary = (await ctx.skills.list(lookup)).find(s => s.name === args.name);
if (!summary) throw new Error(`skill "${args.name}" is unknown or no longer available`);
if (!isModelInvocable(summary)) throw new Error(`skill "${args.name}" is not available for model invocation`);
```

### (a) Frontmatter disable — WORKS end-to-end (recommended for "hide it forever")

Add `disable-model-invocation: true` (optionally `user-invocable: false`) to the SKILL.md. That is an
edit, not a delete. Effects: catalog omits it; `skill` tool hits the fixed refusal above; `/name` still
works unless you also set `user-invocable: false`; `ctx.remote.skills` drops it when user-disabled.
The change reaches the model without a restart: the fs provider watches roots and calls its
registration-scoped `invalidate()` (`isRelevantWatchEvent` `:555`, `queueInvalidation`), and the next
`agent/pre-step` republishes the catalog when the digest changes (`digestCatalogEntries` `:1035`).

### (b) Runtime shadow skill — mechanism real, but the LAYER kills it for shipped skills

`ctx.skills.register({ name, description, content, source, invocation:{modelInvocable:false,
userInvocable:false} })` does shadow a same-name skill **within its own layer**, by rank 250 vs 300/400/500/600.
It does **not** shadow a project skill (ranks 100/200 beat 250), and — the decisive part — a
**host-level** plugin registers into the *global* layer, while the shipped filesystem provider lives in
the *preset generation* layer, which wins outright on name. A host-level shadow is then a silent no-op:
`skills.get(name)` still returns the filesystem body, the catalog still lists it, and the `skill` tool
keeps working. To use this mechanism the plugin row must be declared **inside each preset's
`plugins:` list** (same layer), and even then project-level skills stay unshadowable.
UNVERIFIED: no live host experiment was run (would require changing the profile, which is out of scope);
the conclusion follows from `collectFresh`/`collectLayer`/`compareIndexedCandidates` plus the measured
composition (preset-mounted provider rows).

### (c) `ctx.tools.guard()` — WORKS for refusal, does nothing for the catalog

`ToolsService.guard(guard)` → `guards.effect(ctx, layer => layer.guards.append(guard))`
(`dsh-tools/lib/index.js:649`); `ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`;
`checkGuards` walks **global layer first**, then the calling agent's chain (`:657-662`), so a host-level
guard covers every agent and every preset. It sees `exec.name`, `exec.arguments` (already-parsed object),
`exec.agent`, `exec.callId`, `exec.signal`. It runs *after* the `tools/pre-execute` waterfall and
approval resolution (`dsh-tools/lib/pipeline.js:386-418`). A returned string becomes:

```js
{ content: [{ type: 'text', text: `Error: ${denialReason}` }], isError: true,
  error: { message: denialReason } }        // pipeline.js:404-418 — the tool body never runs
```
Guards are monotonic (deny-only), synchronous, and still fire `tools/result` observers
(`finish` → `notifyResult`, `pipeline.js:551-596`), so usage accounting still sees the attempt.

```js
// host-level plugin: covers all presets/agents; refuses without hiding.
export const inject = ['tools']
export function apply(ctx, config) {
  const disabled = new Set(config.disabled ?? [])
  ctx.effect(() => ctx.tools.guard((exec) => {
    if (exec.name !== 'skill') return
    const name = exec.arguments?.name
    return typeof name === 'string' && disabled.has(name)
      ? `skill "${name}" is disabled in this profile (skill dashboard); do not retry it`
      : undefined
  }), 'skill-dashboard.guard')
}
```

### (d) Rejected / partial candidates

- `ctx.tools.restrict({ deny:['skill'] })` (`index.js:450`) requires a **scoped** context (throws for a
  global one) and removes the whole tool; because of the identity check at `tool-skill:935` it also
  retires the whole catalog (an empty replacement is appended). All-or-nothing: useless per skill.
- A same-name scoped `skill` tool shadow also kills the entire catalog, not one entry.

**Recommendation for the dashboard:** store your enabled/disabled map in plugin storage, enforce refusal
with a host-level `tools.guard()` (immediate, per-skill, clear model-visible reason), and offer
"hide from catalog" as an explicit file edit that writes `disable-model-invocation: true` into the
SKILL.md (idempotent, reversible, no deletion). Do not build the product on a host-level runtime shadow.

## 4. Usage stats: where a load is observable

`skill` tool definition (`dsh-tool-skill/lib/index.js:787-894`): name `skill`, parameters
`{ name: { type:'string', required:true } }`, output `{ name, provider, resourceBase?, content }`,
rendered as `<skill_content>`. Tool row title `Load skill <name>`.

| Signal | Event / API | Payload | Durable? |
|---|---|---|---|
| call finished (incl. denials) | `ctx.on('tools/result', (exec, result) => …)` | `exec.name`, `exec.arguments` (object), `exec.agent`, `exec.callId`; `result.isError` | no (in-process emit) |
| before dispatch (can also allow) | `tools/pre-execute` waterfall `(exec, next)` | same `exec`; return `{kind:'deny', reason}` | no |
| around dispatch | `tools/execute` waterfall `(exec, next)` | same | no |
| post-normalize | `tools/post-execute` waterfall `(exec, result, next)` | same + result | no |
| durable call record | session event `tool/call` | `{ turn, step, callId, name, arguments }` (arguments = raw JSON **string**) | **yes** |
| durable result record | session event `tool/result` | `{ turn, step, message, error?:{name,code,reason}, meta? }` | **yes** |
| user `/name` gesture | durable `user/message` with `source.kind === 'skill-invocation'` | `{ kind, name, form:'instructions' }` (`tool-skill:912-923`) | **yes** |
| what the model saw | durable `user/message` with `source.kind === 'skill-catalog'` | `{ entries:[{name,description}], update?, incomplete? }` (`tool-skill:984-1016`) | **yes** |
| cache invalidation | `skills/change` emit, **no payload** (`dsh-skill:403`) | — | n/a |

`tool/call` / `tool/result` are appended by `BatchSettlement` whenever the batch has a log position
(`dsh-tools/lib/pipeline.js:178-213`, `start()`/`commit()`); the agent loop always supplies one
(`dsh-agent-loop/lib/index.js:961-971`, `log: { turn, step }`). A *denied* call still commits a normal
`tool/result` with `isError: true` and `content` = `Error: <reason>`, so denials are countable too.

Count per skill:

```js
ctx.on('tools/result', (exec, result) => {
  if (exec.name !== 'skill') return
  const skill = exec.arguments?.name
  if (typeof skill === 'string') stats.bump(skill, result.isError ? 'failed' : 'loaded')
})
// plus user gestures: ctx.on('session/event', (session, event) => { ... })
```

**Reconstruction from the session log: yes, but not from the raw file.** Logs are zstd-compressed
(`~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd`), so use the query service:

```js
const docs = await ctx.sessionQuery.filterEvents(sessionId, [{ kind: 'type', values: ['tool/call'] }])
// or ctx.sessionQuery.listEvents(sessionId) / readSession(sessionId) / readEvent({sessionId, seq})
```
`SessionEventResultFilter` supports `type`, `seq`, `time`, `surface`, and literal `text`, so
`tool/call` + parsed `arguments.name` gives a durable per-skill invocation ledger across cold sessions.

## 5. Client data path

`sessionSkillCatalog` is a `TypertRemoteService` with `namespace: 'skills'`
(`dsh-api-session-controller/lib/types/skill-catalog.js:106`), i.e. it publishes the Remote method
`skills/list`.

- Request: `{ sessionId: SessionId }` → `Promise<{ skills: readonly SkillEntry[] }>`
- `SkillEntry = { name, description, modelInvocable, path?, whenToUse? }` (no bodies)
- Filtered to **user-invocable** skills only (`…list(...).filter(isUserInvocable)`, `:162`).
- Errors: `RemoteError('session/not-found', …)` or `RemoteError('gateway/internal', 'skill registry is absent…')`.
- It never activates a cold Agent: it reads `sessionQuery.observeSession(sessionId)` for cwd/preset,
  then either `agentPresets.serviceFor(live,'skills')` (live) or `agentPresets.acquireScope(preset)`
  (cold) and calls `skills.list({ cwd, scope })` (`:116-175`).

Client side: `ctx.remote.skills.list({ sessionId })` — VERIFIED for the shipped UI by
`@deepseek-ai/dsh-client-ui-skill` (its `/` source calls `skills/list`), UNVERIFIED live here: the
client Inspect provider timed out (`Service.listService` on platform `client`, twice, 10 s), so no
runtime probe was possible. Caveat from that package's README: the RPC requires a retained/attached
Client Session (it waits for the initial history open, then sends `skills/list`), and it is
per-session — there is no cross-preset query on the client.

## 6. Write-safety notes for a plugin that manipulates skills

- The registry has **no TTL**. Caches are keyed by `(cwd, scope-chain ids, revision)`, max
  `collectCacheMaxEntries` = 128 (`dsh-skill:120, 265-297, 395-401`). Only three things invalidate it:
  a provider's `invalidate()`, a runtime `register()`/dispose, and provider registration/disposal.
- `invalidate()` is **registration-scoped and one-shot**: it no-ops once that exact registration no
  longer owns the name (`dsh-skill:151-157`). Capture the `control` you receive, do not stash a global.
- `fs` writes from a plugin only get the *synchronous* invalidation path if the acting tool is literally
  named `edit` or `write` (`mutationToolName`, `dsh-skill-filesystem:578-582` via the `fs/observed`
  listener at `:56`). Writes through your own tool, `pwsh`, or a script fall back to chokidar
  (depth 1, `awaitWriteFinish` stability 200 ms) — i.e. **eventually**, not synchronously.
- Publishing is step-bounded: `tool-skill` only republishes at `agent/pre-step`, and only when the
  digest over entries+completeness changes (`:931-964`). Between your write and the next step, the model
  can still call the tool — that gap is exactly why a `tools.guard()` belongs in front of the tool.
- Provider/fiber teardown unregisters and invalidates; a runtime registration made in a preset layer
  dies with that preset generation. Dashboard-side caches should key on `skills/change`
  (payload-free) and refetch with explicit `{cwd, scope}` rather than holding summaries.
- HMR: the `hmr` row mounts with `config: { root: [] }` (`dsh-base/cordis.patch.yml:28-32`), so plugin
  modules are not hot-reloaded by default; profile/config changes arrive as `app-boot/config-reload`.
  `skills/change` and `plugin-manager/changed` are the two events a dashboard must re-read on.
- Never cache a `ScopeKey` (see §2) and never call a business Service from Inspect providers — Inspect
  is read-only; a dashboard plugin uses `ctx.skills` / `ctx.agentPresets` directly.

---

### UNVERIFIED / not checked
- No live runtime experiment for the shadow-skill layer claim (would need a profile edit; out of scope).
  Derived from `collectFresh` + measured composition instead.
- Client `ctx.remote.skills` runtime shape (client Inspect provider timed out; shipped `dsh-client-ui-skill`
  source/README is the evidence).
- Exact `skill`-tool behavior under the `ptc`/`minimal` presets (they also mount `skill-filesystem` +
  `tool-skill`; `minimal` does not — not enumerated in detail).
- `dsh-system-prompt/assemble` was not read: the catalog is definitively **not** a prompt section — it is
  a durable user-role message created in `agent/pre-step` (`dsh-tool-skill:966-1018`).
