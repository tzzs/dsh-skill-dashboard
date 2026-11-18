# Agent-skill registries — verified research (2026-11-17, probes run from this machine)

All HTTP shapes below are **observed**, not inferred. Truncations marked `…`.

## 0. What this DSH install already has (checked first)

| Probe | Result |
|---|---|
| `read …\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\find-skills\SKILL.md` (and `lark-skill-maker`) | **not found** |
| full-ASCII scan of `app.asar` (213,202,918 B) for `find-skills`, `skills.sh`, `skillhub` | **0 hits each** |
| `SKILL.md` entries inside `app.asar` | 12, all under `agent-experience`, `cordis-*`, `editing-cordis-compositions`, `*assets/office-*` |
| extracted asar tree `_dsh_src/…\dsh-agent-preset\skills\` (unpacked by a teammate) | only 4 skills; glob `**/find-skills/**` in `_dsh_src` → 0 files |
| `$DSH_HOME/settings.yaml` grep `skill|registry|source|mirror|market|hub` | **0 matches** |
| `$DSH_HOME/.env` | no skill or registry configuration |
| `$DSH_HOME/skills` | does not exist |

⇒ **This build ships no built-in "skills.sh source" and no configured registry.** There is nothing to reuse; the plugin must own both sources.

### Skill roots the plugin should install into (from bundled `@deepseek-ai/dsh-skill-filesystem` docs, read out of `app.asar`)
| Rank | Source | Path |
|---|---|---|
|100|`project-dsh`|`<projectRoot>/.dsh/skills`|
|200|`project-agents`|`<projectRoot>/.agents/skills`|
|300|`custom`|`Config.customSkillDirs`|
|400|`user-dsh`|`$DSH_HOME/skills` → `~/.dsh/skills`|
|500|`user-agents`|`$DSH_AGENTS_HOME/skills` → `~/.agents/skills`|
|600|`bundled`|`$DSH_BUNDLED_SKILL_DIR`|

Env observed: `DSH_HOME=~/.dsh`, `DSH_PROFILE=desktop`, `DSH_PROFILE_DIR=$DSH_HOME/profiles/desktop`. `dshHome` defaults to `$DSH_HOME` or `~/.dsh`; roots are **watched** (`watch: true`) so a written skill appears without restart.

---

## 1. skills.sh — Vercel Labs "The Agent Skills Directory"

**Identity:** an *index over Git repos*, not a package host. `GET https://skills.sh` → 200, `Server: Vercel`, `<title>The Agent Skills Directory</title>`, `description: Discover and install skills for AI agents.` Canonical `https://www.skills.sh`. Content sources are GitHub/GitLab repos; downloads are git fetches.

**robots.txt (observed):** `Allow: /` · `Disallow: /internal/`, `/debug-security/`, `/search`, `/api/`.

### 1a. Search — the only public JSON endpoint found
```
GET https://skills.sh/api/search?q=pdf&limit=200        (no auth)
200 · application/json · 15,641 B for q=pdf
{"query":"pdf","searchType":"fuzzy","searchVersion":"algolia",
 "skills":[{"id":"anthropics/skills/pdf","source":"anthropics/skills","skillId":"pdf",
            "name":"pdf","installs":230923}, …],
 "count":100,"duration_ms":304,
 "timings_ms":{"rate_limit":21.6,"retrieval":237.6,"algolia_processing":270,"total":326.4},
 "provider_duration_ms":237.6}
```
* `limit` caps at **200** (`limit=1000` → `count:200`), default 100, **no pagination** (`page=`/`offset=` ignored, same first record). Missing `q` → **400**.
* Headers: `Cache-Control: public, must-revalidate, max-age=0`, `Server-Timing`, `X-Matched-Path: /api/search`, `X-Search-Version: algolia`. **No ACAO**, no `X-RateLimit-*`, no `Retry-After`; 10 rapid requests → 10×200 at 0.78–1.23 s each (no 429).
* **Records carry no description and no version** — detail must come from the HTML page or GitHub.

### 1b. Detail (no JSON API — auth-gated and 404s)
`/api/skill/{owner}/{repo}/{skill}` → **401**. `/api/skills…`, `/api/featured`, `/api/trending`, `/api/popular`, `/api/stats`, `/api/home`, `/api/owners` → **404**.

`GET https://skills.sh/anthropics/skills/pdf` → 200 · 121,771 B HTML containing `npx skills add https://github.com/anthropics/skills --skill pdf`, the literal in-repo path `skills/pdf`, and JSON-LD `SoftwareApplication` `{name:"pdf", description:"Use this skill whenever the user wants to do anything with PDF files…", publisher:{name:"anthropics"}, interactionStatistic:{userInteractionCount:230949}}` ← scrape-able description + installs.

Sitemaps (useful for a cold "browse all"): `/sitemap.xml` → `sitemap-owners.xml` (1.17 MB, `https://www.skills.sh/<owner>`) + `sitemap-skills-1|2.xml` (875 KB each, `https://www.skills.sh/<owner>/<repo>/<skillId>`). **Not install-ordered** — cannot be used as a featured/ranked list.

### 1c. Install / fetch
Official CLI: npm `skills@1.9.0` (`bin: skills, add-skill`), repo `vercel-labs/skills`; deps `simple-git` + `tar` ⇒ **git clone or tarball** against any git host. Source formats (`docs/commands.md`): `owner/repo`, `owner/repo@v1.2.3`, `https://github.com/o/r`, `…/tree/main/skills/x`, GitLab, Azure, `git@…`, local dir.

Raw path (verified, no git needed): `GET https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md` → `200 · 8,021 B · ACAO: *`; body = `---\nname: pdf\ndescription: Use this skill whenever the user wants to do anything with PDF files…\nlicense: Complete terms in LICENSE.txt\n---\n\n# PDF Processing Guide…`.
Path discovery (no clone): `GET https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1` (UA required) → `truncated:false`, **20** paths ending `SKILL.md` (`skills/pdf/SKILL.md`, `skills/academy-guide/SKILL.md`, …).
Discovery rules (`docs/creating-skills.md`): containers `""`, `skills/`, `skills/.curated|.experimental|.system/`, `.agents/skills/`, `.claude/skills/`, `.codebuddy/skills/`. … 60+ agent dirs, walked **≤3 levels**; `skills.sh.json {"paths":["./tools/skills"]}` adds containers; `.claude-plugin/marketplace.json` honoured.

**SKILL.md contract:** YAML frontmatter, required `name` (lowercase-hyphen) + `description`; optional `metadata.internal: true` (hidden unless `INSTALL_INTERNAL_SKILLS=1`).

### 1d. Updates / versioning
There is **no version field** in the index. Two options:
1. Commit pinning (what the CLI does): `GET https://api.github.com/repos/{o}/{r}/commits?per_page=1` → `sha=e4bb5d960d87126ff3b3a8af1a104b7db67560ba`, `X-RateLimit-Remaining: 49`. Re-fetch raw at the pinned sha (immutable).
2. Content hash (CLI `skills-lock.json` v2 `computedHash`): sort files by UTF-8 path bytes, skip `metadata.json`/`.git`/`__pycache__`/`__pypackages__`, CRLF→LF for text files, then SHA-256 over `path NUL len-decimal-NUL content` per file. Test vector: `SKILL.md = "# hi\n"` → `93c36952d8843b33e68ae970ebabcc03e1687c9bb0dd1ecaf357060318952f55`. This maps cleanly onto DSH's "a skill is just SKILL.md" model.
`raw.githubusercontent.com` and `api.github.com` both send `ACAO: *`; **GitHub API unauthenticated = 60 req/h** (observed `limit=60`), ETag present (`W/"21f1…"`) so conditional GETs are cheap.

---

## 2. Tencent domestic source — **SkillHub (`skillhub.cn`)**, ranked #1

**Identification evidence (all observed):** page shell served from `cloudcache.tencent-cloud.com/qcloud/tea/app/skillhub/assets/skill-hub.dc3cj3ht.js`, `window.CDN_HOST="cloudcache.tencent-cloud.com"` + backup `.cn`/`.tencentcs.com`; bundle maps `{"skillhub.cn":"https://api.skillhub.cn","skillhub.tencent.com":"https://api.skillhub.tencent.com"}`; security reports link `tix.qq.com` and `static.cloudsec.tencent.com`; enterprise list contains 腾讯科技（深圳）有限公司 (`publishedSkillCount:163`, `totalDownloads:8633795`); zips are served from `skillhub-1388575217.cos.accelerate.myqcloud.com` (Tencent COS); `Server: TencentEdgeOne`; ICP/beian link present. It is a China-optimised mirror of **ClawHub** (`skill.source:"clawhub"`, `upstream_url:"https://clawhub.ai/<owner>/<slug>"`, `changelog:"Synced by skillhub pipeline"`).

**Base URL:** `https://api.skillhub.cn` (intl twin: `https://api.skillhub.tencent.com`). No auth, no cookies, no `Referer` needed for everything below.

### 2a. Search + list (single endpoint)
```
GET https://api.skillhub.cn/api/skills?page=1&pageSize=20&sortBy=score&keyword=pdf
200 · application/json · {"code":0,"data":{"skills":[…],"total":5524}}
```
Params (from bundle + probes): `page`, `pageSize`, `sortBy=score|downloads`, `order`, `keyword` (ASCII or URL-encoded中文 both work), `category`, `subCategories`, `labels`, `source=all|enterprise|community`. `sortBy=trending` → **400**; omitting `keyword` is fine with `sortBy`.
Record (real, trimmed): `{"slug":"multi-search-engine","name":"全网搜索","description":"…","description_zh":"…","category":"knowledge-management","version":"1.0.2","downloads":826667,"installs":0,"stars":7,"score":35000,"namespace":{"canonicalName":"@zhaopintong/multi-search-engine","displayName":"zhaopintong","handle":"zhaopintong","publicSlug":"multi-search-engine"},"publisher":{"name":"招聘通AI","verified":true,"certifiedName":"广东招聘通人力资源有限公司","orgId":"org-euacy8dv"},"source":"enterprise","subCategories":[{"key":"knowledge-retrieval","name":"信息检索"}],"labels":{"requires_api_key":"false"},"homepage":"https://api.skillhub.cn/zhaopintong/multi-search-engine","iconUrl":"https://skillhub-1388575217.cos.accelerate.myqcloud.com/skill-icons/uploads/…png","verified":false,"claim_state":"unclaimed","updated_at":1794864983772}`
Corpus size observed: `total=228620` (all), `keyword=pdf → 5524`, `搜索 → 25567`, `腾讯 → 1416`.

### 2b. Detail / files / download
```
GET https://api.skillhub.cn/api/v1/skills/{slug}                       → 200, 2,112 B
{"slug":"qq-email","latestVersion":{"version":"1.0.0","changelog":"Synced by skillhub pipeline","createdAt":1774801466849},
 "namespace":{"canonicalName":"@clawhub_chao-nj-cn/qq-email",…},"owner":{…},
 "securityReports":{"keen":{"status":"benign","statusText":"安全，无风险"},
                    "sanbu":{"status":"suspicious","statusText":"可疑，存在潜在风险",…}},
 "skill":{"summary":"…","summary_zh":"…","stats":{"downloads":2358,"installs":134,"stars":1,"versions":1},
          "labels":{"requires_api_key":"true"},"source":"clawhub","sourceUrl":"https://clawhub.ai/chao-nj-cn/qq-email",…}}

GET …/api/v1/skills/{slug}/files[?version=1.0.0]
200 {"count":5,"version":"1.0.0","files":[{"path":"README.md","sha256":"f9db59d5…","size":4812},
 {"path":"SKILL.md","sha256":"38885336…","size":3333},{"path":"_meta.json",…},
 {"path":"qq_email.py","sha256":"6694174c…","size":23098},{"path":"skill-card.md",…}]}

GET …/api/v1/skills/{slug}/file?path=SKILL.md[&version=1.0.0]
200 · application/octet-stream · 3,333 B = raw SKILL.md bytes   ← best install path

GET …/api/v1/skills/{slug}/versions → per-version changelog + per-version securityReports

GET …/api/v1/download?slug=qq-email[&version=1.0.0][&tag=][&namespace=]
302 · Location: https://skillhub-1388575217.cos.accelerate.myqcloud.com/skills/qq-email/1.0.0.zip
    Content-Disposition: attachment; filename="qq-email-1.0.0.zip"
    Access-Control-Expose-Headers: …X-SkillHub-GitHub-Commit, X-SkillHub-Skipped-Files-Count, X-SkillHub-File-Count
```
`HEAD /api/v1/download` → 405, so use GET without following the redirect to read `Location` cheaply.

### 2c. Featured / taxonomy (all unauth, all 200)
`GET /api/v1/categories` (1,540 B, 13 items: `pay-skill`, `office-efficiency`, `content-creation`, `dev-programming`, `data-analysis`, `design-media`, `ai-agent`, `knowledge-management`, `business-ops`, `education`, …) · `GET /api/v1/subcategories` (13,965 B, 96 items, `parentKey`) · `GET /api/v1/enterprises/featured` (5,055 B) · `GET /api/v1/enterprises/hot-skills` (16,898 B, hot-skill leaderboard: `dev-god` 11.5M downloads …) · `GET /api/v1/skillsets` (125,422 B; bundles whose `content` field embeds a full SKILL.md).

**Auth:** none required above. `POST /api/v1/skills` → **401**; publish/claim/comment endpoints need `Authorization` / `X-Skillhub-Token` / `X-API-Key`.

### 2d. Candidate ranking (unauthenticated, desktop-friendly)
1. **`api.skillhub.cn`** — 228k skills, JSON search, per-file raw fetch, zip mirror on Tencent COS, CN-anycast (EdgeOne). **Recommended.**
2. `api.skillhub.tencent.com` — byte-identical API, intl name; use as fallback origin.
3. **ClawHub** `clawhub.ai` — upstream of most SkillHub records (`npm clawhub@0.26.0`); overseas host, so no CN benefit, adds a second schema.
4. 腾讯云 AI 网关「Skill 市场」 (`tencentcloud.com/document/product/1310/83987`) — console-only, needs a Cloud account; **unusable** for a desktop app.
5. 腾讯 CodeBuddy skills — IDE marketplace, no public download API found.
⚠️ npm `skillhub@0.4.1` (`skills.palebluedot.live`, github.com/airano-ir/skillhub) is an **unrelated** project — do not confuse with Tencent SkillHub.

---

## 3. CORS matrix — what must go through the DSH Host

| Endpoint | ACAO observed | Browser-safe? |
|---|---|---|
| `https://skills.sh/api/search` | **absent** (OPTIONS → 204, still no ACAO) | ✗ Host only |
| `https://api.skillhub.cn/api/**` | **absent** (has `Allow-Credentials/Methods/Expose-Headers`) | ✗ Host only |
| `https://raw.githubusercontent.com/…` | `*` | ✓ |
| `https://api.github.com/**` | `*` | ✓ (60/h unauth) |
| `https://cdn.jsdelivr.net/gh/…` | `*` | ✓ |
| `https://skillhub-…cos.accelerate.myqcloud.com/…zip` | n/a signed CDN | ✗ prefer Host |

**Rule: proxy every registry call through the DSH Host process.** Renderer can keep GitHub/raw/jsDelivr direct.

---

## 4. Algorithm for the plugin

Canonical ref (string, stable): `skills.sh:<owner>/<repo>[/<path>][@<sha>]` · `skillhub:<slug>[@<version>]`.

```
search(query, {locale, limit=30})
  if (locale.zh OR skillhubPreferred)
      GET https://api.skillhub.cn/api/skills?page=1&pageSize=limit&keyword=<enc(query)>&sortBy=score
        → data.skills[]  → normalize {source:'skillhub', id:slug, name, desc:description_zh||description,
                                     version, installs:installs||downloads, owner:namespace.canonicalName, icon:iconUrl}
      if it fails/times out (2.5s) → fall through to skills.sh
  GET https://skills.sh/api/search?q=<enc(query)>&limit=200          (no auth, no paging)
    → skills[] {id:"o/r/skillId", source:"o/r", skillId, name, installs}
    rank in memory by installs; take top `limit`
  merge: dedupe on lowercase(name); keep both sources as separate rows (schemas differ, no shared ids)

listFeatured()
  skillhub: GET /api/v1/enterprises/hot-skills        (leaderboard, has icons + namespaces)
            + GET /api/skills?page=1&pageSize=24&sortBy=downloads   (fills the grid)
            + GET /api/v1/categories / /api/v1/subcategories        (facet chips)
  skills.sh: no featured API (all 404) → GET /api/search?q=skill&limit=200 and sort by `installs`,
             or scrape /sitemap-skills-*.xml for the browse-all index (never for ranking)

install(ref)
  1. Host resolves ref → staging dir under $DSH_HOME/cache/skill-downloads/<tmp>
  2. skillhub: GET /api/v1/skills/{slug}/files (sha256+size per file); then per path
              GET /api/v1/skills/{slug}/file?path=<enc(path)>&version=<v>; verify sha256
     skills.sh: commit = GET https://api.github.com/repos/{o}/{r}/commits?per_page=1 (ETag, 5 min cache)
              paths = GET …/git/trees/{sha}?recursive=1 ; blobs = raw.githubusercontent/{o}/{r}/{sha}/{path}
              (CN fallback: https://cdn.jsdelivr.net/gh/{o}/{r}@{sha}/{path})
  3. Validate: `SKILL.md` exists, frontmatter parses, `name`+`description` present, name matches [a-z0-9-]+
  4. Atomic move staging → `<root>/<name>/`; root = project `.dsh/skills` (rank 100) if project-scoped
     else `$DSH_HOME/skills` (rank 400)
  5. Sidecar `<root>/<name>/.skill-source.json`
       {"source":"skillhub","slug":"qq-email","version":"1.0.0",
        "files":{"SKILL.md":"38885336…"},"commit":null,"fetchedAt":"…"}

checkUpdate(ref)     // cheap, no full download
  skillhub: GET /api/v1/skills/{slug} → latestVersion.version vs sidecar.version
            (optional) GET /api/v1/skills/{slug}/versions → newest changelog + securityReports
  skills.sh: GET …/commits?per_page=1 (If-None-Match) → sha vs sidecar.commit,
             or recompute CLI-compatible computedHash over the installed folder
  return {current, latest, changelog?, security?}; only `install()` when the user accepts
```

**Minimum auth story:** skillhub = **none** (all reads anonymous; do not send tokens). skills.sh search = **none**. GitHub = **none, 60 req/h per IP** — cache aggressively (`ETag`, 5–15 min TTL), and optionally read `GITHUB_TOKEN`/`GH_TOKEN` from env for 5,000/h. No API keys, no OAuth, no cookies needed anywhere in the happy path.

**Rate-limit notes observed:** skills.sh — no `X-RateLimit-*`, no 429 in 10 bursts, ~0.8–1.2 s/req (serialize, ≥300 ms gap, cache 10 min). api.skillhub.cn — no rate headers, `Server: TencentEdgeOne`, `EO-Cache-Status: MISS`; still debounce to 1 req/s and batch metadata via `POST /api/v1/skills/batch {"slugs":[…]}` when needed. GitHub — 60/h unauth (`remaining:49` after our probes).

---

## 5. Graceful degradation

| Failure | Detect | Fallback |
|---|---|---|
| skills.sh blocked/slow (mainland CN) | `GET /api/search` timeout >2.5 s or TLS/connect error | **skillhub only**; hide skills.sh tab, show banner "使用国内源 SkillHub 镜像". For git-only refs, fetch via `cdn.jsdelivr.net/gh/...` (verified identical bytes, `ACAO:*`) — raw.githubusercontent is the piece that usually breaks in CN |
| raw.githubusercontent blocked | fetch error | `https://cdn.jsdelivr.net/gh/{o}/{r}@{ref}/{path}` (verified), then `https://gitee.com` mirror if the user configured one |
| api.skillhub.cn blocked (outside CN / corporate proxy) | 4xx/5xx/timeout | try `https://api.skillhub.tencent.com` (same API), then switch to skills.sh + GitHub |
| GitHub API 403/rate-limited | `X-RateLimit-Remaining: 0` | use `owner/repo@vX.Y.Z` tag raw URLs without API; or ETag cache; or `jsDelivr` (no API needed, resolves tags) |
| Both down | both probes fail in one health check | serve cached catalog from `$DSH_HOME/cache/skill-catalog.json` (TTL 24 h) + installed list; install disabled with reason |

Health probe (single, cheap, cached 5 min): `HEAD https://skills.sh/api/search?q=a&limit=1` and `GET https://api.skillhub.cn/api/v1/categories`. Remember both hosts send **no ACAO** → run the probes in the **Host** process only.

## 6. Source-of-truth URLs to hardcode
```
SKILLSH_SEARCH   = https://skills.sh/api/search?q={q}&limit={n}          (n<=200)
SKILLSH_DETAIL   = https://skills.sh/{owner}/{repo}/{skillId}            (HTML+JSON-LD)
SKILLSH_MANIFEST = https://cdn.jsdelivr.net/gh/{owner}/{repo}@{sha}/…    (CN-safe raw mirror)
GITHUB_TREE      = https://api.github.com/repos/{o}/{r}/git/trees/{ref}?recursive=1
GITHUB_COMMIT    = https://api.github.com/repos/{o}/{r}/commits?per_page=1
SKILLHUB_LIST    = https://api.skillhub.cn/api/skills?page={p}&pageSize={n}&keyword={q}&sortBy=score
SKILLHUB_DETAIL  = https://api.skillhub.cn/api/v1/skills/{slug}
SKILLHUB_FILES   = https://api.skillhub.cn/api/v1/skills/{slug}/files?version={v}
SKILLHUB_RAW     = https://api.skillhub.cn/api/v1/skills/{slug}/file?path={path}&version={v}
SKILLHUB_ZIP     = https://api.skillhub.cn/api/v1/download?slug={slug}&version={v}   (302)
SKILLHUB_FEATURED= https://api.skillhub.cn/api/v1/enterprises/hot-skills
```
