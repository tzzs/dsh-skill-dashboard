/**
 * Host half of the Skill Dashboard bundle.
 *
 * Owns four exact HTTP routes on the Host (the transport proven by
 * `dsh-idle-power`): the merged skill catalog for every agent preset, the
 * mutation actions the browser panel offers, a discovery proxy for the two
 * external skill registries, and bounded read-only file previews. Disabling a
 * skill is *only* a frontmatter edit —
 * there is no second switch anywhere in the Harness.
 *
 * Contract: `docs/CONTRACT.md` §3 (transport), §4 (HTTP API), §5 (behaviour).
 *
 * @module @local/dsh-skill-dashboard
 */

import { copyFile, lstat, mkdir, open, opendir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Cordis plugin name. */
export const name = 'skill-dashboard'

/**
 * The Host carrier, the skill registry, and nothing else: every optional
 * service (`agentPresets`, `connection`, `workingDirectory`) is read with
 * `ctx.get(...)` behind an `undefined` check so a lean profile still activates.
 */
export const inject = ['webServer', 'skills']

const STATE_PATH = '/skill-dashboard/state'
const ACTION_PATH = '/skill-dashboard/action'
const DISCOVER_PATH = '/skill-dashboard/discover'
const PREVIEW_PATH = '/skill-dashboard/preview'

const MAX_PREVIEW_FILES = 200
const MAX_PREVIEW_ENTRIES = 2000
const MAX_PREVIEW_DEPTH = 6
const MAX_PREVIEW_TEXT_BYTES = 128 * 1024
const PREVIEW_CACHE_MS = 15_000
const PREVIEW_CACHE_CAP = 32
const PREVIEW_BINARY_EXTENSION = /\.(?:png|jpe?g|gif|webp|ico|avif|bmp|pdf|zip|gz|tar|7z|rar|woff2?|ttf|otf|mp[34]|wav|ogg|exe|dll|so|dylib|wasm|pyc|bin)$/i

/** Metadata classification is a hint; only the selected file is decoded. */
function previewMetadata(path, size = 0) {
  return { path, size, kind: PREVIEW_BINARY_EXTENSION.test(path) ? 'binary' : 'text' }
}

const PREVIEW_EXCLUDED = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.cache', '.venv', 'venv'])

/** Preview paths are deliberately stricter than install payload paths. */
function previewRelativePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f:]/.test(value)) return null
  const path = sanitizeSkillRelativePath(value)
  if (path === null || path.split('/').some((part) => PREVIEW_EXCLUDED.has(part.toLowerCase()))) return null
  return path
}

/** Use platform path semantics (including case sensitivity) for read boundaries. */
function previewInside(root, path) {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/** Decode at most the display cap, without splitting a UTF-8 character. */
function previewContent(path, bytes, size) {
  let content
  try {
    if (bytes.includes(0)) throw new Error('binary')
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: size > bytes.length })
  } catch {
    return { path, content: null, kind: 'binary', size, truncated: false }
  }
  return { path, content, kind: 'text', size, truncated: size > bytes.length }
}

/** Bounded file read; unreadable files remain selectable as metadata. */
async function readPreviewFile(root, absolute, path, limit = MAX_PREVIEW_TEXT_BYTES) {
  let handle
  let size = 0
  try {
    const info = await lstat(absolute)
    size = info.size
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file')
    const real = await realpath(absolute)
    if (!previewInside(root, real)) throw new Error('outside skill directory')
    handle = await open(real, 'r')
    const opened = await handle.stat()
    if (!opened.isFile()) throw new Error('not a regular file')
    size = opened.size
    const bytes = Buffer.alloc(Math.min(size, limit))
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    return previewContent(path, bytes.subarray(0, bytesRead), size)
  } catch {
    return { path, content: null, kind: 'unavailable', size, truncated: false }
  } finally {
    await handle?.close()
  }
}

/** Walk only regular entries, with bounded work even for wide/deep directories. */
async function localPreviewFiles(root, skillPath) {
  const files = []
  let visited = 0
  let truncatedFiles = false
  const add = async (absolute, path) => {
    try {
      const info = await lstat(absolute)
      if (!info.isFile() || info.isSymbolicLink()) return
      files.push(previewMetadata(path, info.size))
    } catch {
      files.push({ path, size: 0, kind: 'unavailable' })
    }
  }
  await add(skillPath, basename(skillPath))
  const walk = async (directory, prefix, depth) => {
    let entries
    try {
      entries = await opendir(directory)
      for await (const entry of entries) {
        visited += 1
        if (visited > MAX_PREVIEW_ENTRIES || files.length >= MAX_PREVIEW_FILES) {
          truncatedFiles = true
          break
        }
        if (PREVIEW_EXCLUDED.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue
        const path = prefix + entry.name
        if (previewRelativePath(path) === null) continue
        const absolute = join(directory, entry.name)
        if (absolute === skillPath) continue
        // Recheck real containment before opening directories, too.
        if (!previewInside(root, await realpath(absolute))) continue
        if (entry.isDirectory()) {
          if (depth >= MAX_PREVIEW_DEPTH) truncatedFiles = true
          else await walk(absolute, `${path}/`, depth + 1)
        } else if (entry.isFile()) await add(absolute, path)
      }
    } catch {
      truncatedFiles = true
    }
  }
  await walk(root, '', 0)
  files.sort((a, b) => skillFileOrder(a.path) - skillFileOrder(b.path) || compareNames(a.path, b.path))
  return { files, truncatedFiles }
}

/** One request body may not exceed this; the routes are small JSON documents. */
const MAX_BODY_BYTES = 1024 * 1024
/** One outbound registry response may not exceed this. */
const MAX_OUTBOUND_BYTES = 4 * 1024 * 1024
/** Every outbound registry request is bounded, including the concurrency fan-out. */
const OUTBOUND_TIMEOUT_MS = 10_000
/** The merged state is reused for this long so a burst of UI fetches scans once. */
const STATE_TTL_MS = 1_500
/** Provider-side `skills/change` bursts debounce into one background refresh. */
const STATE_INVALIDATE_DEBOUNCE_MS = 250
/** A frontmatter write is trusted over the catalog for this long (watcher lag). */
const RECENT_EDIT_TTL_MS = 5_000
/** Both JSON stores flush at most once per this window. */
const STORE_FLUSH_MS = 800

const DAY_WINDOW = 14
const DAY_KEEP = 60
const SESSION_CAP = 200
const RECENT_CAP = 20

const MAX_FALLBACK_SKILLS = 500
const MAX_INSTALL_FILES = 40
const MAX_INSTALL_BYTES = 1024 * 1024
const MAX_FILE_FETCH_CONCURRENCY = 4

const SEARCH_CACHE_MS = 60_000
const PAYLOAD_CACHE_MS = 10 * 60_000
const TREE_CACHE_MS = 10 * 60_000
/** Unauthenticated GitHub allows 60 API requests an hour; commit lookups share that budget. */
const COMMIT_CACHE_MS = 60_000
/** The detected coding agents are re-read at most once per this window. */
const RUNTIME_CACHE_MS = 30_000
/** `.skill-lock.json` is re-read at most once per this window; its mtime invalidates within it. */
const LOCK_CACHE_MS = 5_000
/** One completed update check is reused for this long before the panel asks upstream again. */
const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000
/** A failed check is retried after this short window instead of waiting the full six hours. */
const UPDATE_CHECK_ERROR_TTL_MS = 10 * 60_000
/** One skill's upstream read during a check; bounded so one chunk stays inside the client's 10 s fetch. */
const UPDATE_CHECK_TIMEOUT_MS = 6_000
/** One `check-updates` call asks about this many skills unless the caller says otherwise. */
const UPDATE_CHECK_LIMIT = 4
const UPDATE_CHECK_LIMIT_MAX = 8

const USER_AGENT = 'dsh-skill-dashboard/1.0 (+https://github.com/tzzs/dsh-skill-dashboard)'

/** Kebab-case skill names, identical to the registry's `SKILL_NAME`. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Source precedence inside the local filesystem provider, used to decide which
 * agent's resolution wins a duplicated skill name. The registry strips `rank`
 * from `SkillSummary`, so the source label is the only rank evidence left.
 */
const SOURCE_RANK = {
  'project-dsh': 100,
  'project-agents': 200,
  runtime: 250,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
}

/** Frontmatter keys the filesystem provider refuses outright. */
const LEGACY_INVOCATION_KEYS = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
}

const KEY_MODEL = 'disable-model-invocation'
const KEY_USER = 'user-invocable'
const TOP_LEVEL_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)[ \t]*:(.*)$/

/** File kinds fetched from a registry when installing a skill. */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.toml',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.ps1',
  '.rb',
  '.go',
])

const DEFAULT_AGENT = { id: 'default', title: 'Default', isDefault: true }

/**
 * Verified registry endpoints. Both APIs are JSON, unauthenticated, and send no
 * CORS headers, which is why the browser half always goes through this Host.
 * Every URL builder lives here so a host change is a one-line edit.
 */
const ENDPOINTS = {
  tencent: {
    /** `keyword` is omitted for an empty query, which lists featured skills. */
    search: (query) => {
      const parameters = ['page=1', 'pageSize=30', 'sortBy=score']
      if (query.length > 0) parameters.push(`keyword=${encodeURIComponent(query)}`)
      return `https://api.skillhub.cn/api/skills?${parameters.join('&')}`
    },
    files: (slug) => `https://api.skillhub.cn/api/v1/skills/${encodeURIComponent(slug)}/files`,
    file: (slug, path) =>
      `https://api.skillhub.cn/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`,
    page: (slug) => `https://skillhub.cn/skills/${encodeURIComponent(slug)}`,
  },
  'skills-sh': {
    /** `q` is required by the upstream API; an empty query searches "skill". */
    search: (query) => `https://skills.sh/api/search?q=${encodeURIComponent(query.length > 0 ? query : 'skill')}&limit=50`,
    tree: (owner, repo, rev) => `https://api.github.com/repos/${owner}/${repo}/git/trees/${rev}?recursive=1`,
    raw: (owner, repo, rev, path) => `https://raw.githubusercontent.com/${owner}/${repo}/${rev}/${path}`,
    page: (id) => `https://skills.sh/${id}`,
    commits: (owner, repo, rev) =>
      `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1${rev ? `&sha=${encodeURIComponent(rev)}` : ''}`,
    /** The public atom feed answers when the REST API refuses an anonymous client. */
    commitsAtom: (owner, repo, rev) => `https://github.com/${owner}/${repo}/commits/${encodeURIComponent(rev)}.atom`,
    flat: (owner, repo, rev) => `https://data.jsdelivr.com/v1/packages/gh/${owner}/${repo}@${encodeURIComponent(rev)}?structure=flat`,
    cdn: (owner, repo, rev, path) =>
      `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${encodeURIComponent(rev)}/${path.split('/').map(encodeURIComponent).join('/')}`,
  },
}

// ---------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------

/** Narrow an arbitrary value to a plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** First non-empty string among `keys`, trimmed. */
function stringField(record, keys) {
  if (!isRecord(record)) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/** First finite number among `keys`. */
function numberField(record, keys) {
  if (!isRecord(record)) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

/** Follow a property path and return the first element that is an array. */
function pickArray(payload, paths) {
  for (const path of paths) {
    let cursor = payload
    let reachable = true
    for (const key of path) {
      if (!isRecord(cursor) && !Array.isArray(cursor)) {
        reachable = false
        break
      }
      cursor = cursor[key]
    }
    if (reachable && Array.isArray(cursor)) return cursor
  }
  return undefined
}

/** Render an arbitrary thrown value without letting coercion escape. */
function errorMessage(error) {
  try {
    if (error instanceof Error) return error.message
    return String(error)
  } catch {
    return 'unknown failure'
  }
}

/** Host name of a URL, safe for error messages that must not leak query strings. */
function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'the upstream registry'
  }
}

/** A failure envelope shared by every internal outcome. */
function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra }
}

/** Compare two skill names the way the registry does (code points, not locale). */
function compareNames(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

// ---------------------------------------------------------------------------
// Reference grammar: one parser for a registry slug and a GitHub reference
// ---------------------------------------------------------------------------

const REF_MAX_LENGTH = 512
const REF_PATH_MAX_LENGTH = 200
const OWNER_OR_REPO = /^[A-Za-z0-9_.-]{1,100}$/
const REF_REV = /^[A-Za-z0-9._-]{1,200}$/
const COMMIT_REV = /^[0-9a-f]{40}$/

/** The one in-place update a skill directory layout cannot express. */
const FLAT_SKILL_MESSAGE = 'a flat skill file cannot be updated in place; remove it and install the skill again'

/**
 * @typedef {object} Locator
 * @property {'tencent'|'skills-sh'} source
 * @property {string} ref - canonical stored form.
 * @property {string} name - default skill-name hint implied by the reference.
 * @property {string} slug - tencent slug; '' for git.
 * @property {string} owner - '' for tencent.
 * @property {string} repo - '' for tencent.
 * @property {string} [rev] - branch, tag, or 40-hex commit; absent means the repository default.
 * @property {string} path - skill directory inside the repository; '' when the repository root is the skill.
 */

/** Whether one revision names a commit rather than a moving branch or tag. */
function isCommitRev(value) {
  return typeof value === 'string' && COMMIT_REV.test(value)
}

const badRef = (message) => ({ ok: false, code: 'bad-request', message })

/**
 * Parse one reference into the locator every adapter takes.
 *
 * Tencent references are a single kebab-case slug. Everything else is a
 * GitHub reference: `owner/repo[@rev][#path]`, `owner/repo/a/b`, or a URL with
 * an optional scheme, `www.`, or bare `github.com/` prefix. The canonical `ref`
 * is what provenance stores, so `parseRef(parseRef(x).value.ref)` must be a
 * fixed point: a URL and its bare form have to land on the same string.
 *
 * @param {unknown} input - reference from a request body or a stored record.
 * @returns {{ ok: true, value: Locator } | { ok: false, code: 'bad-request', message: string }} outcome.
 */
export function parseRef(input) {
  if (typeof input !== 'string') return badRef('a reference must be a string')
  const text = input.trim()
  if (text.length === 0) return badRef('a reference is required')
  if (text.length > REF_MAX_LENGTH) return badRef(`a reference must be at most ${REF_MAX_LENGTH} characters`)
  if (/[\u0000-\u001f\u007f]/.test(text)) return badRef('a reference must not contain control characters')
  if (text.includes('\\')) return badRef('a reference must use forward slashes')

  let body = text
  let fromUrl = false
  if (/^(?:https?:\/\/|www\.|github\.com\/)/i.test(text)) {
    fromUrl = true
    body = text.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
    if (!/^github\.com\//i.test(body)) return badRef('a URL reference must point at github.com')
    body = body.slice('github.com/'.length)
  }

  let path = ''
  const hash = body.indexOf('#')
  if (hash >= 0) {
    path = body.slice(hash + 1)
    body = body.slice(0, hash)
  }
  // GitHub directory URLs and pasted paths often carry one trailing slash.
  if (path.endsWith('/')) path = path.slice(0, -1)
  if (body.endsWith('/')) body = body.slice(0, -1)

  let rev
  if (!fromUrl) {
    const at = body.indexOf('@')
    if (at >= 0) {
      rev = body.slice(at + 1)
      body = body.slice(0, at)
      if (!REF_REV.test(rev)) return badRef('a revision may only use letters, digits, ".", "_" and "-"')
    }
  }

  const segments = body.split('/')
  if (segments.length === 1) {
    const slug = segments[0]
    if (rev !== undefined || path.length > 0) return badRef(`"${slug}" is a skill slug and takes no revision or path`)
    if (!SKILL_NAME.test(slug)) return badRef(`"${slug}" is neither a skill name nor an owner/repo reference`)
    return { ok: true, value: { source: 'tencent', ref: slug, name: slug, slug, owner: '', repo: '', path: '' } }
  }

  const owner = segments[0]
  let repo = segments[1]
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4)
  if (!OWNER_OR_REPO.test(owner) || owner === '.' || owner === '..') {
    return badRef(`"${owner}" is not a valid repository owner`)
  }
  if (!OWNER_OR_REPO.test(repo) || repo === '.' || repo === '..') return badRef(`"${repo}" is not a valid repository name`)

  let rest = segments.slice(2)
  if (fromUrl && (rest[0] === 'tree' || rest[0] === 'blob')) {
    const kind = rest[0]
    if (rest.length < 2 || rest[1].length === 0) return badRef(`a /${kind}/ URL must name a revision`)
    rev = rest[1]
    if (!REF_REV.test(rev)) return badRef('a revision may only use letters, digits, ".", "_" and "-"')
    rest = rest.slice(2)
    if (kind === 'blob') {
      if (rest.length === 0 || rest[rest.length - 1].toLowerCase() !== 'skill.md') {
        return badRef('a /blob/ URL must point at a SKILL.md file')
      }
    }
  }
  if (rest.length > 0) {
    const named = rest.join('/')
    if (path.length > 0 && path !== named) return badRef('the reference names two different paths')
    path = named
  }

  const pathSegments = path.length > 0 ? path.split('/') : []
  if (pathSegments.length > 0 && pathSegments[pathSegments.length - 1].toLowerCase() === 'skill.md') pathSegments.pop()
  path = pathSegments.join('/')
  if (path.length > REF_PATH_MAX_LENGTH) return badRef(`a reference path must be at most ${REF_PATH_MAX_LENGTH} characters`)
  if (path.startsWith('/')) return badRef('a reference path must be relative')
  if (pathSegments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return badRef('a reference path must not contain ".", "..", or an empty segment')
  }
  // "#" and "?" would split the canonical form in two places.
  if (pathSegments.some((segment) => /[#?]/.test(segment))) {
    return badRef('a reference path must not contain "#" or "?"')
  }

  const name = pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : repo
  const canonical = `${owner}/${repo}${rev === undefined ? '' : `@${rev}`}${path.length > 0 ? `#${path}` : ''}`
  return {
    ok: true,
    value: { source: 'skills-sh', ref: canonical, name, slug: '', owner, repo, ...(rev === undefined ? {} : { rev }), path },
  }
}

// ---------------------------------------------------------------------------
// Frontmatter: read, validate, and rewrite only the two invocation keys
// ---------------------------------------------------------------------------

/**
 * Split text into lines while remembering each line's exact terminator, so a
 * rewrite can reproduce every untouched byte.
 * @param {string} text - complete file text.
 * @returns {{ text: string, eol: string }[]} lines in order.
 */
export function splitTextLines(text) {
  const lines = []
  let start = 0
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character !== '\n' && character !== '\r') {
      index += 1
      continue
    }
    const eol = character === '\r' && text[index + 1] === '\n' ? '\r\n' : character
    lines.push({ text: text.slice(start, index), eol })
    index += eol.length
    start = index
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' })
  return lines
}

/**
 * Join previously split lines back into text; the inverse of `splitTextLines`.
 * @param {{ text: string, eol: string }[]} lines - lines with terminators.
 * @returns {string} the reconstructed text.
 */
export function joinTextLines(lines) {
  let text = ''
  for (const line of lines) text += line.text + line.eol
  return text
}

/**
 * Locate the leading `---` frontmatter block.
 * @param {{ text: string }[]} lines - split lines of a SKILL.md file.
 * @returns {{ open: number, close: number } | null} line indices, or null when absent.
 */
export function locateFrontmatter(lines) {
  if (lines.length === 0 || lines[0].text !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].text === '---') return { open: 0, close: index }
  }
  return null
}

/** Decode the scalar subset this editor needs: plain, single- and double-quoted. */
function decodeScalar(raw) {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value.length === 0) return undefined
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const inner = value.slice(1, -1)
    return inner.replace(/\\(["\\/nrt])/g, (match, escape) => {
      switch (escape) {
        case 'n':
          return '\n'
        case 'r':
          return '\r'
        case 't':
          return '\t'
        default:
          return escape
      }
    })
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  // A YAML comment can only follow a space, and never inside a plain scalar.
  const comment = value.search(/[ \t]#/)
  return comment < 0 ? value : value.slice(0, comment).trim()
}

/** Decode a YAML boolean the way the filesystem provider does. */
function decodeBoolean(raw) {
  const value = decodeScalar(raw)
  if (value === undefined) return undefined
  const lowered = value.toLowerCase()
  if (lowered === 'true' || lowered === 'yes' || lowered === 'on' || lowered === '1') return true
  if (lowered === 'false' || lowered === 'no' || lowered === 'off' || lowered === '0') return false
  return undefined
}

/**
 * Parse a SKILL.md file's frontmatter into the fields this plugin needs.
 *
 * The registry only accepts files whose first line is exactly `---`, that carry
 * a `name` and a `description`, and that never use one of the legacy invocation
 * keys, so this reader mirrors those rules instead of guessing.
 *
 * @param {string} text - complete file text.
 * @returns {{ ok: true, name: string, description: string, whenToUse?: string,
 *   modelInvocable: boolean, userInvocable: boolean }} parsed fields, or
 *   `{ ok: false, code, message }` when the provider would reject the file.
 */
export function parseSkillFrontmatter(text) {
  if (typeof text !== 'string') return failure('invalid-frontmatter', 'the skill file is not text')
  const lines = splitTextLines(text)
  const block = locateFrontmatter(lines)
  if (block === null) return failure('missing-frontmatter', 'the file must start with a --- frontmatter block')
  const entries = new Map()
  for (let index = block.open + 1; index < block.close; index += 1) {
    const line = lines[index].text
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue
    const match = TOP_LEVEL_KEY.exec(line)
    if (match === null) {
      // Indented lines belong to the previous top-level key and stay opaque.
      if (!/^[ \t]/.test(line)) {
        return failure('invalid-frontmatter', `frontmatter line ${index + 1} is not a top-level key`)
      }
      continue
    }
    if (entries.has(match[1])) return failure('invalid-frontmatter', `frontmatter repeats the key "${match[1]}"`)
    entries.set(match[1], match[2])
  }
  for (const legacy of Object.keys(LEGACY_INVOCATION_KEYS)) {
    if (entries.has(legacy)) {
      return failure(
        'invalid-frontmatter',
        `frontmatter field "${legacy}" is unsupported; use "${LEGACY_INVOCATION_KEYS[legacy]}"`,
      )
    }
  }
  const name = decodeScalar(entries.get('name'))
  if (name === undefined) return failure('invalid-frontmatter', 'frontmatter requires a name')
  if (!SKILL_NAME.test(name)) return failure('invalid-frontmatter', `invalid skill name "${name}"`)
  const description = decodeScalar(entries.get('description'))
  if (description === undefined) return failure('invalid-frontmatter', 'frontmatter requires a description')
  let modelInvocable = true
  let userInvocable = true
  if (entries.has(KEY_MODEL)) {
    const value = decodeBoolean(entries.get(KEY_MODEL))
    if (value === undefined) return failure('invalid-frontmatter', `frontmatter field "${KEY_MODEL}" must be a boolean`)
    modelInvocable = value !== true
  }
  if (entries.has(KEY_USER)) {
    const value = decodeBoolean(entries.get(KEY_USER))
    if (value === undefined) return failure('invalid-frontmatter', `frontmatter field "${KEY_USER}" must be a boolean`)
    userInvocable = value !== false
  }
  const whenToUse = decodeScalar(entries.get('whenToUse'))
  return {
    ok: true,
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    modelInvocable,
    userInvocable,
  }
}

/**
 * Rewrite only `disable-model-invocation` and `user-invocable` inside the
 * leading frontmatter block, preserving every other line byte-for-byte.
 *
 * A key is removed when its value returns to the Harness default (`model:
 * true`, `user: true`); otherwise it is written as a single canonical line at
 * the end of the block. The result is re-parsed before it is handed back, so a
 * caller never writes a file the provider would reject.
 *
 * @param {string} text - complete file text.
 * @param {{ modelInvocable?: boolean, userInvocable?: boolean }} change - requested flags.
 * @returns {{ ok: true, text: string, changed: boolean } |
 *   { ok: false, code: string, message: string }} the rewritten text.
 */
export function applyInvocationEdit(text, change) {
  const parsed = parseSkillFrontmatter(text)
  if (parsed.ok !== true) return parsed
  const modelInvocable = change?.modelInvocable === undefined ? parsed.modelInvocable : change.modelInvocable === true
  const userInvocable = change?.userInvocable === undefined ? parsed.userInvocable : change.userInvocable === true
  if (modelInvocable === parsed.modelInvocable && userInvocable === parsed.userInvocable) {
    return { ok: true, text, changed: false }
  }
  const lines = splitTextLines(text)
  const block = locateFrontmatter(lines)
  if (block === null) return failure('missing-frontmatter', 'the file must start with a --- frontmatter block')
  const eol = lines[block.open + 1]?.eol || lines[block.open].eol || '\n'
  const kept = []
  for (let index = block.open + 1; index < block.close; index += 1) {
    const key = TOP_LEVEL_KEY.exec(lines[index].text)?.[1]
    if (key === KEY_MODEL || key === KEY_USER) continue
    kept.push(lines[index])
  }
  const appended = []
  if (modelInvocable === false) appended.push({ text: `${KEY_MODEL}: true`, eol })
  if (userInvocable === false) appended.push({ text: `${KEY_USER}: false`, eol })
  if (appended.length > 0 && kept.length > 0) {
    const last = kept[kept.length - 1]
    if (last.eol === '') kept[kept.length - 1] = { text: last.text, eol }
  }
  const rewritten = joinTextLines([
    ...lines.slice(0, block.open + 1),
    ...kept,
    ...appended,
    ...lines.slice(block.close),
  ])
  const verified = parseSkillFrontmatter(rewritten)
  if (verified.ok !== true) {
    return failure('invalid-frontmatter', `refusing to write a broken frontmatter: ${verified.message}`)
  }
  if (verified.modelInvocable !== modelInvocable || verified.userInvocable !== userInvocable) {
    return failure('invalid-frontmatter', 'the rewritten frontmatter does not resolve to the requested flags')
  }
  return { ok: true, text: rewritten, changed: rewritten !== text }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Comparison key for an absolute path: one separator, no trailing separator,
 * lowercase so Windows comparisons are stable.
 * @param {string} value - path in any separator style.
 * @returns {string} comparable key.
 */
export function normalizePathKey(value) {
  const unified = String(value).replace(/[\\/]+/g, sep).replace(/[\\/]+$/, '')
  return unified.toLowerCase()
}

/**
 * Whether `candidate` is `root` itself or lives inside it.
 * @param {string} root - containing directory.
 * @param {string} candidate - path to test.
 * @returns {boolean} true when contained.
 */
export function isInsidePath(root, candidate) {
  if (typeof root !== 'string' || root.length === 0) return false
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const rootKey = normalizePathKey(root)
  const candidateKey = normalizePathKey(candidate)
  if (rootKey.length === 0) return false
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`)
}

/**
 * Whether a path belongs to the DSH installation and must stay read-only, which
 * covers both an installation root and anything inside a packed `.asar`.
 * @param {string} candidate - absolute path to test.
 * @param {readonly string[]} installRoots - absolute installation roots.
 * @returns {boolean} true when the path must not be written or deleted.
 */
export function isProtectedInstallPath(candidate, installRoots) {
  if (typeof candidate !== 'string' || candidate.length === 0) return true
  const key = normalizePathKey(candidate)
  if (key.split(sep).some((segment) => segment.endsWith('.asar'))) return true
  for (const root of installRoots ?? []) {
    if (typeof root === 'string' && root.length > 0 && isInsidePath(root, candidate)) return true
  }
  return false
}

/**
 * Directory that owns one skill file, or `null` for a flat `<name>.md` skill.
 * @param {string} path - the skill file path from the catalog.
 * @returns {string | null} the skill directory.
 */
export function skillDirectoryOf(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  return basename(path).toLowerCase() === 'skill.md' ? dirname(path) : null
}

/**
 * Validate one fetched file path as a path relative to the skill directory.
 * @param {unknown} value - candidate path from a registry payload.
 * @returns {string | null} normalized relative path, or null when unsafe.
 */
export function sanitizeSkillRelativePath(value) {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').trim()
  if (normalized.length === 0) return null
  if (normalized.startsWith('/')) return null
  if (/^[A-Za-z]:/.test(normalized)) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

/**
 * Provenance for one catalog skill, derived from the skills CLI's `.skill-lock.json`.
 *
 * The lock records every skill the CLI installed, but reads it by name: a
 * same-named skill can live in another root, so a mapping is trusted only when
 * the catalog's directory is exactly `<root>/<name>` and the recorded
 * `skillPath` agrees about the folder. Anything ambiguous answers `null`.
 *
 * @param {{ name?: string, dir?: string | null }} skill - catalog entry.
 * @param {unknown} lock - parsed `.skill-lock.json`.
 * @param {string} root - the user agents skill root.
 * @returns {{ source: 'github', ref: string, version: null, installedAt: number | null } | null} installed shape.
 */
export function lockProvenanceOf(skill, lock, root) {
  const name = typeof skill?.name === 'string' ? skill.name : ''
  const directory = typeof skill?.dir === 'string' ? skill.dir : ''
  if (name.length === 0 || directory.length === 0 || typeof root !== 'string' || root.length === 0) return null
  if (normalizePathKey(directory) !== normalizePathKey(join(root, name))) return null
  const entries = isRecord(lock) && isRecord(lock.skills) ? lock.skills : {}
  const entry = Object.hasOwn(entries, name) ? entries[name] : undefined
  if (!isRecord(entry)) return null
  if (entry.sourceType !== undefined && entry.sourceType !== 'github') return null
  const source = typeof entry.source === 'string' ? entry.source : ''
  const segments = source.split('/')
  if (segments.length !== 2) return null
  const [owner, repo] = segments
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo)) return null
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  if (typeof entry.skillPath !== 'string') return null
  const pathSegments = entry.skillPath.replace(/\\/g, '/').replace(/^\.\//, '').split('/')
  if (pathSegments[pathSegments.length - 1].toLowerCase() !== 'skill.md') return null
  const folderSegments = pathSegments.slice(0, -1)
  if (folderSegments.length > 0 && folderSegments[folderSegments.length - 1].toLowerCase() !== name.toLowerCase()) return null
  if (folderSegments.some((part) => part.length === 0 || part === '.' || part === '..')) return null
  const folder = folderSegments.join('/')
  const updatedAt = Date.parse(entry.updatedAt)
  return {
    source: 'github',
    ref: folder.length === 0 ? `${owner}/${repo}` : `${owner}/${repo}#${folder}`,
    version: null,
    installedAt: Number.isFinite(updatedAt) ? updatedAt : null,
  }
}

/**
 * The CONTRACT §4 update-check block, limited to names the catalog still lists.
 *
 * `checkedAt` is the oldest record among the tracked skills, not the newest.
 * An interrupted walk leaves the unchecked names at zero, so the panel asks
 * again on the next mount instead of waiting out the full TTL.
 *
 * @param {unknown} updatesState - parsed `updates.json`.
 * @param {{ name: string, dir?: string | null, installed?: unknown }[]} skills - merged catalog.
 * @returns {{ checkedAt: number, available: { name: string, changedPaths: string[], checkedAt: number }[] }} state block.
 */
export function describeUpdates(updatesState, skills) {
  const records = isRecord(updatesState?.skills) ? updatesState.skills : {}
  const listed = Array.isArray(skills) ? skills : []
  const present = new Set(listed.map((skill) => skill.name))
  let checkedAt = 0
  let tracked = false
  for (const skill of listed) {
    if (!isRecord(skill.installed) || typeof skill.dir !== 'string' || skill.dir.length === 0) continue
    const record = Object.hasOwn(records, skill.name) ? records[skill.name] : undefined
    const at = isRecord(record) && Number.isFinite(record.checkedAt) ? record.checkedAt : 0
    checkedAt = tracked ? Math.min(checkedAt, at) : at
    tracked = true
  }
  if (!tracked) checkedAt = 0
  const available = []
  for (const [name, record] of Object.entries(records)) {
    if (!isRecord(record)) continue
    const at = Number.isFinite(record.checkedAt) ? record.checkedAt : 0
    if (!present.has(name) || record.available !== true) continue
    available.push({
      name,
      changedPaths: Array.isArray(record.changedPaths) ? record.changedPaths.filter((path) => typeof path === 'string') : [],
      checkedAt: at,
    })
  }
  available.sort((left, right) => compareNames(left.name, right.name))
  return { checkedAt, available }
}

/**
 * Relative paths whose fetched bytes differ from the local skill tree.
 *
 * Shared by `update` (its `changed` flag) and `check-updates`, so both answer
 * the same question about the same fetched file set.
 *
 * @param {string} directory - local skill directory.
 * @param {{ path: string, text: string }[]} files - fetched file set.
 * @returns {Promise<string[]>} changed relative paths, in fetch order.
 */
export async function changedSkillPaths(directory, files) {
  const changed = []
  for (const file of Array.isArray(files) ? files : []) {
    const relativePath = sanitizeSkillRelativePath(file?.path)
    if (relativePath === null) continue
    const existing = await readFile(join(directory, relativePath), 'utf8').catch(() => undefined)
    if (existing !== file.text) changed.push(relativePath)
  }
  return changed
}

// ---------------------------------------------------------------------------
// Coding agent runtimes
// ---------------------------------------------------------------------------

/**
 * The coding agents whose skill directories this dashboard detects.
 *
 * The table mirrors the `skills` CLI registry
 * (`vercel-labs/skills/src/agents.ts`), which documents each agent's project
 * and global skill directories and the universal `.agents/skills` convention.
 * `markers` are home-relative directories whose existence proves the agent is
 * installed; `roots` are the agent's own skill directories, either
 * home-relative or project-relative (`cwd/`). A `universal` runtime also reads
 * the canonical `.agents/skills` roots, which every agent may share.
 *
 * `dsh` is last: it always exists and sees every catalog skill.
 */
export const RUNTIME_REGISTRY = [
  {
    id: 'claude-code',
    title: 'Claude Code',
    universal: false,
    markers: ['.claude'],
    roots: ['.claude/skills', 'cwd/.claude/skills'],
  },
  {
    id: 'codex',
    title: 'Codex',
    universal: true,
    markers: ['.codex'],
    roots: ['.codex/skills', 'cwd/.codex/skills'],
  },
  {
    id: 'cursor',
    title: 'Cursor',
    universal: true,
    markers: ['.cursor'],
    roots: ['.cursor/skills', 'cwd/.cursor/skills'],
  },
  {
    id: 'gemini-cli',
    title: 'Gemini CLI',
    universal: true,
    // `~/.gemini` belongs to Antigravity on this machine, and Antigravity does
    // not read the canonical roots, so the marker is the skills directory.
    markers: ['.gemini/skills'],
    roots: ['.gemini/skills', 'cwd/.gemini/skills'],
  },
  {
    id: 'github-copilot',
    title: 'GitHub Copilot',
    universal: true,
    markers: ['.copilot'],
    roots: ['.copilot/skills', 'cwd/.github/skills'],
  },
  {
    id: 'opencode',
    title: 'OpenCode',
    universal: true,
    markers: ['.config/opencode'],
    roots: ['.config/opencode/skills', 'cwd/.opencode/skills'],
  },
  {
    id: 'amp',
    title: 'Amp',
    universal: true,
    markers: ['.config/amp'],
    roots: ['.config/agents/skills'],
  },
  {
    id: 'cline',
    title: 'Cline',
    universal: true,
    markers: ['.cline'],
    roots: [],
  },
  {
    id: 'droid',
    title: 'Droid',
    universal: true,
    markers: ['.factory'],
    roots: ['.factory/skills'],
  },
  {
    id: 'kilo',
    title: 'Kilo Code',
    universal: true,
    markers: ['.kilo', '.kilocode'],
    roots: ['.kilo/skills'],
  },
  {
    id: 'kimi-code-cli',
    title: 'Kimi Code CLI',
    universal: true,
    markers: ['.kimi-code', '.kimi'],
    roots: [],
  },
  {
    id: 'pi',
    title: 'Pi',
    universal: true,
    markers: ['.pi/agent'],
    roots: [],
  },
  {
    id: 'warp',
    title: 'Warp',
    universal: true,
    markers: ['.warp'],
    roots: [],
  },
  {
    id: 'zed',
    title: 'Zed',
    universal: true,
    markers: ['.config/zed'],
    roots: [],
  },
  {
    id: 'fx',
    title: 'fx',
    universal: true,
    markers: ['.fx'],
    roots: [],
  },
  {
    id: 'dsh',
    title: 'DSH',
    universal: true,
    markers: [],
    roots: ['cwd/.dsh/skills', 'cwd/.agents/skills', '$DSH_HOME/skills', '$DSH_AGENTS_HOME/skills'],
  },
]

/** Entries of a skill root that are never skills. */
const RUNTIME_SKIPPED_ENTRIES = new Set(['.system', '.kits'])

/**
 * Resolve one registry path to an absolute path.
 *
 * `cwd/` is project-relative, `$DSH_HOME` and `$DSH_AGENTS_HOME` are the two
 * Home roots, and everything else is home-relative.
 *
 * @param {string} entry - registry path.
 * @param {{ home: string, cwd: string, agentsHome: string, dshHome: string }} context - absolute roots.
 * @returns {string} the absolute path.
 */
function runtimeRootPath(entry, context) {
  if (entry.startsWith('cwd/')) return join(context.cwd, ...entry.slice('cwd/'.length).split('/'))
  if (entry === '$DSH_HOME/skills') return join(context.dshHome, 'skills')
  if (entry === '$DSH_AGENTS_HOME/skills') return join(context.agentsHome, 'skills')
  return join(context.home, ...entry.split('/'))
}

/**
 * Detect the coding agents that read the skill directories on this machine.
 *
 * A runtime is present when one of its marker directories or one of its own
 * roots exists. A universal runtime sees a skill whose resolved directory
 * lives inside a resolved canonical root (`.agents/skills`) or that resolves
 * to an entry of one of its own roots; a non-universal runtime only claims a
 * skill that resolves to an entry of one of its own roots. Every comparison
 * runs on resolved paths, so a broken junction never counts and a directory
 * that links into the canonical root is still recognised as that skill.
 *
 * @param {{ home: string, cwd: string, agentsHome: string, dshHome?: string, skills: { name: string, dir: string | null }[] }} options - roots and catalog skills.
 * @returns {Promise<{ runtimes: { id: string, title: string, skills: string[] }[], bySkill: Map<string, string[]> }>} detected runtimes.
 */
export async function detectAgentRuntimes({ home, cwd, agentsHome, dshHome, skills }) {
  const context = {
    home: typeof home === 'string' && home.length > 0 ? home : homedir(),
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd(),
    agentsHome: typeof agentsHome === 'string' && agentsHome.length > 0 ? agentsHome : join(homedir(), '.agents'),
    dshHome: typeof dshHome === 'string' && dshHome.length > 0 ? dshHome : join(homedir(), '.dsh'),
  }
  const catalog = Array.isArray(skills) ? skills : []
  const wanted = new Set()
  for (const skill of catalog) {
    if (isRecord(skill) && typeof skill.name === 'string' && skill.name.length > 0) wanted.add(skill.name.toLowerCase())
  }

  /** Resolve one path, or null when it does not exist. */
  const resolve = async (path) => {
    try {
      return await realpath(path)
    } catch {
      return null
    }
  }

  /** Whether one directory exists. */
  const isDirectory = async (path) => {
    try {
      const info = await stat(path)
      return info.isDirectory()
    } catch {
      return false
    }
  }

  const canonicalPaths = [join(context.agentsHome, 'skills'), join(context.cwd, '.agents', 'skills')]
  const resolvedCanonical = await Promise.all(canonicalPaths.map((path) => resolve(path)))
  const canonicalRoots = resolvedCanonical.filter((resolved) => resolved !== null).map(normalizePathKey)
  const isInCanonical = (path) => canonicalRoots.some((root) => path === root || path.startsWith(`${root}${sep}`))

  /** One listing per root, reused by every runtime that reads that root. */
  const listings = new Map()
  const listRoot = (path) => {
    if (listings.has(path)) return listings.get(path)
    const pending = (async () => {
      try {
        const entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
        return entries
          .filter((entry) => !RUNTIME_SKIPPED_ENTRIES.has(entry.name))
          .map((entry) => entry.name)
      } catch {
        return []
      }
    })()
    listings.set(path, pending)
    return pending
  }

  /** The resolved skill entries of one root: directories and flat `.md` skills. */
  const entryCache = new Map()
  const entriesOf = (path) => {
    if (entryCache.has(path)) return entryCache.get(path)
    const pending = (async () => {
      const candidates = []
      for (const name of await listRoot(path)) {
        const key = name.toLowerCase()
        const flat = key.endsWith('.md') ? key.slice(0, -3) : null
        if (!wanted.has(key) && (flat === null || !wanted.has(flat))) continue
        candidates.push({ name, key, flat })
      }
      const resolvedList = await Promise.all(candidates.map((candidate) => resolve(join(path, candidate.name))))
      const directories = new Map()
      const files = new Map()
      for (let index = 0; index < candidates.length; index += 1) {
        const resolved = resolvedList[index]
        if (resolved === null) continue
        const { key, flat } = candidates[index]
        if (flat !== null) files.set(flat, normalizePathKey(resolved))
        else directories.set(key, normalizePathKey(resolved))
      }
      return { directories, files }
    })()
    entryCache.set(path, pending)
    return pending
  }

  // Every skill is placed by its resolved directory, or, for a flat skill, by
  // the resolved files the roots list for it. A skill whose directory cannot
  // be resolved keeps no path, so no agent root claims it.
  const validCatalog = catalog.filter((skill) => isRecord(skill) && typeof skill.name === 'string' && skill.name.length > 0)
  const locations = await Promise.all(
    validCatalog.map(async (skill) => {
      const key = skill.name.toLowerCase()
      if (typeof skill.dir === 'string' && skill.dir.length > 0) {
        const resolved = await resolve(skill.dir)
        return { name: skill.name, key, flat: false, paths: resolved === null ? [] : [normalizePathKey(resolved)] }
      }
      return { name: skill.name, key, flat: true, paths: [] }
    }),
  )
  const flatLocations = locations.filter((location) => location.flat)
  if (flatLocations.length > 0) {
    const rootPaths = new Set(canonicalPaths)
    for (const runtime of RUNTIME_REGISTRY) {
      for (const entry of runtime.roots) rootPaths.add(runtimeRootPath(entry, context))
    }
    const rootEntries = await Promise.all([...rootPaths].map((path) => entriesOf(path)))
    for (const location of flatLocations) {
      for (const { files } of rootEntries) {
        const resolved = files.get(location.key)
        if (resolved !== undefined) location.paths.push(normalizePathKey(resolved))
      }
    }
  }

  const probedRuntimes = await Promise.all(
    RUNTIME_REGISTRY.map(async (runtime) => {
      const rootChecks = await Promise.all(
        runtime.roots.map(async (entry) => {
          const path = runtimeRootPath(entry, context)
          const [dirExists, resolved] = await Promise.all([
            runtime.id === 'dsh' ? Promise.resolve(true) : isDirectory(path),
            resolve(path),
          ])
          const own = resolved !== null ? await entriesOf(path) : null
          return { dirExists, own }
        }),
      )
      let present = runtime.id === 'dsh' || rootChecks.some((check) => check.dirExists)
      const ownEntries = rootChecks.map((check) => check.own).filter((own) => own !== null)
      if (!present && runtime.markers.length > 0) {
        const markerChecks = await Promise.all(
          runtime.markers.map((marker) => isDirectory(runtimeRootPath(marker, context))),
        )
        present = markerChecks.some(Boolean)
      }
      return { runtime, present, ownEntries }
    }),
  )

  const runtimes = []
  const bySkill = new Map()
  for (const { runtime, present, ownEntries } of probedRuntimes) {
    if (!present) continue

    const names = []
    for (const location of locations) {
      // A dot entry is not a skill of any root, wherever it is found.
      if (RUNTIME_SKIPPED_ENTRIES.has(location.name)) continue
      const inCanonical = runtime.universal && location.paths.some(isInCanonical)
      const inOwnRoot = location.paths.some((path) => {
        if (location.flat && !runtime.universal && isInCanonical(path)) return false
        return ownEntries.some((own) => own.directories.get(location.key) === path || own.files.get(location.key) === path)
      })
      if (!inCanonical && !inOwnRoot) continue
      names.push(location.name)
      const claimed = bySkill.get(location.name) ?? []
      claimed.push(runtime.id)
      bySkill.set(location.name, claimed)
    }
    if (runtime.id === 'dsh') {
      // DSH serves every catalog skill, including the flat ones and the ones
      // that live outside every agent root.
      for (const location of locations) {
        if (names.includes(location.name)) continue
        names.push(location.name)
        const claimed = bySkill.get(location.name) ?? []
        if (!claimed.includes('dsh')) claimed.push('dsh')
        bySkill.set(location.name, claimed)
      }
    }
    if (names.length === 0) continue
    runtimes.push({ id: runtime.id, title: runtime.title, skills: names })
  }
  return { runtimes, bySkill }
}

/** Rank a skill source; unknown labels rank below every known source. */
function sourceRank(source) {
  if (typeof source !== 'string') return Number.MAX_SAFE_INTEGER
  return SOURCE_RANK[source] ?? Number.MAX_SAFE_INTEGER
}

/**
 * Whether one discovery hit can be installed, and why not when it cannot.
 *
 * A tencent hit is always installable. A skills.sh hit resolves a repository
 * through `fetch`, which requires exactly `owner/repo`; the directory also
 * lists skills hosted elsewhere (`skills.voices.com`, `clawhub.ai`), and
 * offering an install button for one of those would only produce an error.
 *
 * @param {{ source?: unknown, ref?: unknown }} item - normalized discovery hit.
 * @returns {{ installable: boolean, installableReason: string | null }} installability.
 */
export function describeInstallability(item) {
  const source = typeof item?.source === 'string' ? item.source : ''
  if (source === 'tencent') return { installable: true, installableReason: null }
  const ref = typeof item?.ref === 'string' ? item.ref : ''
  const segments = ref.split('/')
  if (segments.length === 2 && segments.every((segment) => segment.trim().length > 0)) {
    return { installable: true, installableReason: null }
  }
  return {
    installable: false,
    installableReason:
      source === 'skills-sh' ? "skills.sh needs an 'owner/repo' reference" : `source "${source}" cannot install "${ref}"`,
  }
}

// ---------------------------------------------------------------------------
// Day buckets
// ---------------------------------------------------------------------------

/** Format one timestamp as a local-timezone `YYYY-MM-DD` day key. */
function dayKey(at) {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * Walk back `length` local calendar days from `now`, ending today.
 * @param {number} now - reference timestamp.
 * @param {number} length - number of day keys.
 * @returns {string[]} day keys, oldest first.
 */
function recentDayKeys(now, length) {
  const anchor = new Date(now)
  anchor.setHours(12, 0, 0, 0)
  const keys = []
  for (let offset = length - 1; offset >= 0; offset -= 1) {
    const day = new Date(anchor.getTime())
    day.setDate(anchor.getDate() - offset)
    keys.push(dayKey(day.getTime()))
  }
  return keys
}

/**
 * Read one `YYYY-MM-DD` day key as a local instant, at noon.
 *
 * Noon is deliberate: an instant at midnight can fall on the neighbouring day
 * in another zone, while the store's keys are Host-local dates.
 *
 * @param {string} key - stored day key.
 * @returns {number | undefined} the instant, or `undefined` when unparseable.
 */
function dayKeyInstant(key) {
  if (typeof key !== 'string') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (match === null) return undefined
  const instant = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0).getTime()
  return Number.isFinite(instant) ? instant : undefined
}

/**
 * Fold a stored day map into one window of buckets.
 * @param {Record<string, number> | undefined} days - stored `YYYY-MM-DD` → count.
 * @param {number} now - reference timestamp.
 * @param {number} [length] - window size in days.
 * @returns {{ date: string, count: number }[]} oldest → today.
 */
export function foldDayBuckets(days, now, length = DAY_WINDOW) {
  const source = isRecord(days) ? days : {}
  return recentDayKeys(now, length).map((date) => {
    const raw = Number(source[date])
    return { date, count: Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0 }
  })
}

/**
 * Drop day buckets older than the retention window.
 * @param {Record<string, number> | undefined} days - stored day map.
 * @param {number} now - reference timestamp.
 * @param {number} [keep] - retained days.
 * @returns {Record<string, number>} the pruned map.
 */
export function pruneDayBuckets(days, now, keep = DAY_KEEP) {
  const allowed = new Set(recentDayKeys(now, keep))
  const pruned = {}
  if (!isRecord(days)) return pruned
  for (const [date, count] of Object.entries(days)) {
    const numeric = Number(count)
    if (allowed.has(date) && Number.isFinite(numeric) && numeric > 0) pruned[date] = Math.trunc(numeric)
  }
  return pruned
}

// ---------------------------------------------------------------------------
// Usage store folding
// ---------------------------------------------------------------------------

/** One empty usage record. */
function emptyUsageRecord() {
  return { count: 0, sessions: [], lastUsedAt: 0, days: {}, model: 0, user: 0 }
}

/**
 * One empty usage store.
 *
 * `since` starts at 0 and not at a clock: a returning clock here would silently
 * re-date every store written before diagnosis existed on its next load.
 */
function emptyUsageStore() {
  return { version: 1, since: 0, catalog: {}, skills: {}, recent: [] }
}

/** One empty provenance store. */
function emptyInstalledStore() {
  return { version: 1, skills: {} }
}

/** One empty update-check store. */
function emptyUpdatesStore() {
  return { version: 1, skills: {} }
}

/**
 * Fold one observed skill use into the in-memory usage store.
 *
 * `channel` distinguishes a model load (`tools/result`) from a user gesture
 * (`/name`), which is the only difference the panel shows.
 *
 * @param {{ version: number, skills: Record<string, object>, recent: object[] }} state - store to mutate.
 * @param {{ name: string, at: number, agentId: string, sessionId?: string, channel: 'model'|'user' }} event - observation.
 * @returns {object} the same store, mutated.
 */
export function applyUsageEvent(state, event) {
  if (!isRecord(state) || !isRecord(event)) return state
  const name = typeof event.name === 'string' ? event.name : ''
  if (name.length === 0) return state
  const at = Number.isFinite(event.at) ? event.at : Date.now()
  const channel = event.channel === 'user' ? 'user' : 'model'
  const record = isRecord(state.skills[name]) ? state.skills[name] : emptyUsageRecord()
  const sessions = Array.isArray(record.sessions) ? record.sessions : []
  record.sessions = sessions
  record.count = Number.isFinite(record.count) ? record.count + 1 : 1
  if (channel === 'user') record.user = (Number.isFinite(record.user) ? record.user : 0) + 1
  else record.model = (Number.isFinite(record.model) ? record.model : 0) + 1
  if (typeof event.sessionId === 'string' && event.sessionId.length > 0 && !sessions.includes(event.sessionId)) {
    sessions.push(event.sessionId)
    if (sessions.length > SESSION_CAP) sessions.splice(0, sessions.length - SESSION_CAP)
  }
  record.lastUsedAt = at
  const key = dayKey(at)
  const days = isRecord(record.days) ? record.days : {}
  days[key] = (Number.isFinite(Number(days[key])) ? Number(days[key]) : 0) + 1
  record.days = pruneDayBuckets(days, at)
  state.skills[name] = record
  const recent = Array.isArray(state.recent) ? state.recent : []
  recent.unshift({ name, at, agentId: typeof event.agentId === 'string' && event.agentId.length > 0 ? event.agentId : 'default' })
  if (recent.length > RECENT_CAP) recent.length = RECENT_CAP
  state.recent = recent
  return state
}

/**
 * Response-shaped usage for one skill.
 * @param {object | undefined} record - stored usage record.
 * @param {number} now - reference timestamp.
 * @returns {{ count: number, sessions: number, lastUsedAt: number | null, days: number[], byModel: number, byUser: number }} summary.
 */
export function summarizeSkillUsage(record, now) {
  const recordValue = isRecord(record) ? record : {}
  const sessions = Array.isArray(recordValue.sessions) ? recordValue.sessions : []
  return {
    count: Number.isFinite(recordValue.count) ? recordValue.count : 0,
    sessions: sessions.length,
    lastUsedAt: Number.isFinite(recordValue.lastUsedAt) && recordValue.lastUsedAt > 0 ? recordValue.lastUsedAt : null,
    days: foldDayBuckets(recordValue.days, now).map((bucket) => bucket.count),
    byModel: Number.isFinite(recordValue.model) ? recordValue.model : 0,
    byUser: Number.isFinite(recordValue.user) ? recordValue.user : 0,
  }
}

/**
 * Response-shaped usage summary for the whole store.
 * @param {{ skills: Record<string, object>, recent: object[] }} state - usage store.
 * @param {number} now - reference timestamp.
 * @returns {{ totalCount: number, activeSkills: number, dayBuckets: {date: string, count: number}[],
 *   recent: object[], history: {date: string, count: number}[], retentionDays: number,
 *   skillUsage: {name: string, count: number, byModel: number, byUser: number,
 *     lastUsedAt: number|null, dayBuckets: {date: string, count: number}[]}[] }} summary.
 */
export function summarizeUsage(state, now) {
  const skills = isRecord(state?.skills) ? state.skills : {}
  const aggregate = {}
  let totalCount = 0
  let activeSkills = 0
  for (const record of Object.values(skills)) {
    if (!isRecord(record)) continue
    const count = Number.isFinite(record.count) ? record.count : 0
    if (count <= 0) continue
    totalCount += count
    activeSkills += 1
    for (const [date, value] of Object.entries(isRecord(record.days) ? record.days : {})) {
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric <= 0) continue
      aggregate[date] = (aggregate[date] ?? 0) + numeric
    }
  }
  const recent = (Array.isArray(state?.recent) ? state.recent : [])
    .filter((entry) => isRecord(entry) && typeof entry.name === 'string')
    .slice(0, RECENT_CAP)
    .map((entry) => ({ name: entry.name, at: Number.isFinite(entry.at) ? entry.at : 0, agentId: String(entry.agentId ?? 'default') }))
  const skillUsage = Object.entries(skills)
    .filter(([, record]) => isRecord(record))
    .map(([name, record]) => ({
      name,
      count: Number.isFinite(record.count) ? record.count : 0,
      byModel: Number.isFinite(record.model) ? record.model : 0,
      byUser: Number.isFinite(record.user) ? record.user : 0,
      lastUsedAt: Number.isFinite(record.lastUsedAt) && record.lastUsedAt > 0 ? record.lastUsedAt : null,
      dayBuckets: foldDayBuckets(record.days, now, DAY_KEEP),
    }))
    .sort((a, b) => b.count - a.count || compareNames(a.name, b.name))
  return {
    totalCount, activeSkills, dayBuckets: foldDayBuckets(aggregate, now), recent,
    history: foldDayBuckets(aggregate, now, DAY_KEEP), retentionDays: DAY_KEEP, skillUsage,
  }
}

// ---------------------------------------------------------------------------
// Skill diagnosis
// ---------------------------------------------------------------------------

/**
 * The only place a day threshold appears (CONTRACT §8.1).
 * `activeDays` matches the Usage tab's own window, `staleDays` is a month of
 * silence, and `watchDays` is the smallest window in which "not called" means
 * anything at all.
 */
export const DIAGNOSIS_POLICY = Object.freeze({
  activeDays: 14,
  staleDays: 30,
  watchDays: 3,
})

const DAY_MS = 86_400_000

/** Wire order of the buckets (CONTRACT §8.3). */
const DIAGNOSIS_BUCKET_RANK = { cleanup: 0, dormant: 1, unknown: 2, kept: 3, active: 4 }

/** Within the cleanup queue, a stale call history outranks never having been called. */
const DIAGNOSIS_CLEANUP_RANK = { stale: 0, unused: 1 }

/**
 * Full days between two instants. A backwards clock yields 0, never a false
 * silence (CONTRACT §8.2).
 * @param {number} from - earlier instant.
 * @param {number} to - later instant.
 * @returns {number} non-negative whole days.
 */
function dayDistance(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, Math.floor((to - from) / DAY_MS))
}

/**
 * The earliest instant the store can prove it has been observing (CONTRACT §8.4).
 *
 * Stores written before diagnosis have no `since`. Their oldest call timestamp
 * or surviving day key is the latest defensible start: using `now` instead
 * would make every historic skill look newly watched. Day keys are the
 * Host-local calendar dates recorded by `applyUsageEvent`, read at local noon.
 *
 * @param {{ since?: unknown, skills?: Record<string, object> }} state - usage store.
 * @param {number} now - reference timestamp.
 * @returns {number} the epoch, clamped to `now`; the input is never mutated.
 */
export function usageEpoch(state, now) {
  const at = Number.isFinite(now) ? now : Date.now()
  const stored = isRecord(state) ? state.since : undefined
  if (Number.isFinite(stored) && stored > 0 && stored <= at) return stored
  let oldest
  const consider = (instant) => {
    if (!Number.isFinite(instant) || instant <= 0) return
    if (oldest === undefined || instant < oldest) oldest = instant
  }
  const skills = isRecord(state?.skills) ? state.skills : {}
  for (const record of Object.values(skills)) {
    if (!isRecord(record)) continue
    consider(Number(record.lastUsedAt))
    const days = isRecord(record.days) ? record.days : {}
    for (const [key, count] of Object.entries(days)) {
      const numeric = Number(count)
      if (!Number.isFinite(numeric) || numeric <= 0) continue
      consider(dayKeyInstant(key))
    }
  }
  if (oldest === undefined) return at
  return Math.min(oldest, at)
}

/** Read one creation time from a Map or a plain record, tolerating either. */
function presenceOf(presence, name) {
  if (presence instanceof Map) return presence.get(name)
  if (isRecord(presence) && Object.hasOwn(presence, name)) return presence[name]
  return undefined
}

/**
 * Fill the observation epoch and each unseen catalog name's first-seen stamp
 * once (CONTRACT §8.4). Existing stamps are never rewritten.
 *
 * A known file creation time is preferred over `now`, so a skill installed
 * months before the dashboard existed does not start a fresh watch window.
 *
 * @param {object} usage - the usage store, mutated in place.
 * @param {readonly (string | { name: string })[]} catalog - current catalog entries.
 * @param {Map<string, number> | Record<string, number> | undefined} presence - creation times by name.
 * @param {number} now - reference timestamp.
 * @returns {boolean} whether anything changed, so the caller only flushes then.
 */
export function stampUsage(usage, catalog, presence, now) {
  if (!isRecord(usage)) return false
  const at = Number.isFinite(now) ? now : Date.now()
  let changed = false
  if (!isRecord(usage.catalog)) {
    usage.catalog = {}
    changed = true
  }
  const stamps = usage.catalog
  const since = usageEpoch(usage, at)
  if (!(Number.isFinite(usage.since) && usage.since > 0 && usage.since <= at)) {
    usage.since = since
    changed = true
  }
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : ''
    if (name.length === 0) continue
    const stored = Number(stamps[name])
    if (Number.isFinite(stored) && stored > 0) continue
    const observed = presenceOf(presence, name)
    const source = Number.isFinite(observed) && observed > 0 ? observed : at
    // NTFS reports a fractional birth time; the store holds whole milliseconds.
    stamps[name] = Math.round(Math.min(Math.max(source, since), at))
    changed = true
  }
  return changed
}

/** Classify one catalog entry; every returned field comes from the wire shape. */
function diagnoseRow(entry, record, context) {
  const usage = isRecord(record) ? record : {}
  const lastUsedAt = Number.isFinite(usage.lastUsedAt) && usage.lastUsedAt > 0 ? usage.lastUsedAt : null
  const keptAt = Number.isFinite(usage.keptAt) && usage.keptAt > 0 ? usage.keptAt : null
  const idleDays = lastUsedAt === null ? null : dayDistance(lastUsedAt, context.now)
  const stamped = Number(context.stamps[entry.name])
  const observed = presenceOf(context.presence, entry.name)
  let firstSeen = context.since
  if (Number.isFinite(stamped) && stamped > 0) firstSeen = Math.min(stamped, context.now)
  else if (Number.isFinite(observed) && observed > 0) firstSeen = Math.min(observed, context.now)
  const watchedDays = dayDistance(firstSeen, context.now)
  const closed = entry.modelInvocable === false && entry.userInvocable === false
  const writable = entry.writable === true
  const thresholds = context.thresholds

  let verdict
  if (lastUsedAt !== null && idleDays <= thresholds.activeDays) verdict = 'active'
  else if (keptAt !== null && (lastUsedAt === null || lastUsedAt <= keptAt)) verdict = 'kept'
  else if (watchedDays < thresholds.watchDays) verdict = 'unknown'
  else if (lastUsedAt === null) verdict = 'unused'
  else if (idleDays >= thresholds.staleDays) verdict = 'stale'
  else verdict = 'cooling'

  let bucket
  if (verdict === 'kept') bucket = 'kept'
  else if (verdict === 'unknown') bucket = 'unknown'
  else if (closed && (verdict === 'stale' || verdict === 'unused')) bucket = 'dormant'
  else if (verdict === 'active' || verdict === 'cooling') bucket = 'active'
  else bucket = 'cleanup'

  const removable = verdict === 'stale' || verdict === 'unused'
  return {
    name: entry.name,
    verdict,
    bucket,
    idleDays,
    watchedDays,
    lastUsedAt,
    useCount: Number.isFinite(usage.count) ? usage.count : 0,
    keptAt,
    closed,
    writable,
    can: {
      disable: writable && !closed && removable,
      remove: writable && removable,
      keep: verdict !== 'active',
    },
  }
}

/** Sort diagnosis rows by bucket, then by the queue rules of CONTRACT §8.3. */
function compareDiagnosisRows(left, right) {
  const bucket = (DIAGNOSIS_BUCKET_RANK[left.bucket] ?? 9) - (DIAGNOSIS_BUCKET_RANK[right.bucket] ?? 9)
  if (bucket !== 0) return bucket
  if (left.bucket === 'cleanup' || left.bucket === 'dormant') {
    const verdict = (DIAGNOSIS_CLEANUP_RANK[left.verdict] ?? 9) - (DIAGNOSIS_CLEANUP_RANK[right.verdict] ?? 9)
    if (verdict !== 0) return verdict
    const idle = (right.idleDays ?? 0) - (left.idleDays ?? 0)
    if (idle !== 0) return idle
    const watched = right.watchedDays - left.watchedDays
    if (watched !== 0) return watched
  } else if (left.bucket === 'active') {
    const idle = (left.idleDays ?? 0) - (right.idleDays ?? 0)
    if (idle !== 0) return idle
  }
  return compareNames(left.name, right.name)
}

/**
 * Classify the whole catalog against the usage store (CONTRACT §8.5).
 *
 * Pure and total: no input is mutated, a missing or corrupt store reads as
 * "never called", and every unique catalog name appears exactly once.
 *
 * @param {readonly { name: string, modelInvocable?: boolean, userInvocable?: boolean, writable?: boolean }[]} catalog - current catalog.
 * @param {{ since?: unknown, catalog?: object, skills?: Record<string, object> }} usage - usage store.
 * @param {{ now?: number, since?: number, presence?: Map<string, number> | object, thresholds?: object }} [context] - reference facts.
 * @returns {{ evaluatedAt: number, since: number, observedDays: number, thresholds: object,
 *   counts: { active: number, cleanup: number, dormant: number, kept: number, unknown: number, total: number },
 *   skills: object[] }} the diagnosis document.
 */
export function diagnoseSkills(catalog, usage, context = {}) {
  const settings = isRecord(context) ? context : {}
  const now = Number.isFinite(settings.now) ? settings.now : Date.now()
  const thresholds = { ...DIAGNOSIS_POLICY }
  if (isRecord(settings.thresholds)) {
    for (const key of ['activeDays', 'staleDays', 'watchDays']) {
      const value = Number(settings.thresholds[key])
      if (Number.isFinite(value) && value >= 0) thresholds[key] = value
    }
  }
  const since = Number.isFinite(settings.since) && settings.since > 0 ? Math.min(settings.since, now) : usageEpoch(usage, now)
  const records = isRecord(usage) && isRecord(usage.skills) ? usage.skills : {}
  const stamps = isRecord(usage?.catalog) ? usage.catalog : {}
  const counts = { active: 0, cleanup: 0, dormant: 0, kept: 0, unknown: 0, total: 0 }
  const rows = []
  const seen = new Set()
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0) continue
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    const row = diagnoseRow(entry, Object.hasOwn(records, entry.name) ? records[entry.name] : undefined, {
      now, since, stamps, presence: settings.presence, thresholds,
    })
    counts[row.bucket] += 1
    counts.total += 1
    rows.push(row)
  }
  rows.sort(compareDiagnosisRows)
  return {
    evaluatedAt: now,
    since,
    observedDays: dayDistance(since, now),
    thresholds: { ...thresholds },
    counts,
    skills: rows,
  }
}

// ---------------------------------------------------------------------------
// Catalog merge
// ---------------------------------------------------------------------------

/**
 * Merge per-agent catalogs into the union shape of CONTRACT §4.
 *
 * Every name appears once: the resolution with the highest source rank wins the
 * summary (path, description, flags), while every agent that resolves the name
 * is collected into `agents`. Usage is attached through `options.usageOf` so the
 * final order is usage desc, then name asc.
 *
 * @param {{ id: string, skills: readonly object[] }[]} lists - one catalog per agent.
 * @param {{ usageOf?: (name: string) => object }} [options] - usage resolver.
 * @returns {object[]} merged, sorted skill entries.
 */
export function mergeAgentSkills(lists, options = {}) {
  const merged = new Map()
  const usageOf = typeof options.usageOf === 'function' ? options.usageOf : () => summarizeSkillUsage(undefined, Date.now())
  for (const list of Array.isArray(lists) ? lists : []) {
    if (!isRecord(list) || typeof list.id !== 'string') continue
    for (const skill of Array.isArray(list.skills) ? list.skills : []) {
      if (!isRecord(skill) || typeof skill.name !== 'string' || skill.name.length === 0) continue
      const invocation = isRecord(skill.invocation) ? skill.invocation : {}
      const candidate = {
        name: skill.name,
        description: typeof skill.description === 'string' ? skill.description : '',
        whenToUse: typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0 ? skill.whenToUse : undefined,
        source: typeof skill.source === 'string' ? skill.source : 'unknown',
        provider: typeof skill.provider === 'string' ? skill.provider : 'unknown',
        path: typeof skill.path === 'string' && skill.path.length > 0 ? skill.path : null,
        dir: skillDirectoryOf(skill.path),
        modelInvocable: invocation.modelInvocable !== false,
        userInvocable: invocation.userInvocable !== false,
        rank: sourceRank(skill.source),
      }
      const existing = merged.get(skill.name)
      if (existing === undefined) {
        merged.set(skill.name, { ...candidate, agents: [list.id] })
        continue
      }
      if (!existing.agents.includes(list.id)) existing.agents.push(list.id)
      if (candidate.rank < existing.rank) {
        const agents = existing.agents
        merged.set(skill.name, { ...candidate, agents })
      }
    }
  }
  const entries = []
  for (const entry of merged.values()) {
    entries.push({
      name: entry.name,
      description: entry.description,
      ...(entry.whenToUse === undefined ? {} : { whenToUse: entry.whenToUse }),
      source: entry.source,
      provider: entry.provider,
      path: entry.path,
      dir: entry.dir,
      agents: entry.agents,
      modelInvocable: entry.modelInvocable,
      userInvocable: entry.userInvocable,
      writable: false,
      usage: usageOf(entry.name),
    })
  }
  entries.sort((left, right) => {
    const difference = (right.usage?.count ?? 0) - (left.usage?.count ?? 0)
    return difference !== 0 ? difference : compareNames(left.name, right.name)
  })
  return entries
}

// ---------------------------------------------------------------------------
// Atomic JSON file store
// ---------------------------------------------------------------------------

/** Write one JSON document atomically: a sibling temp file, then a rename. */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch {
      // The temp file is disposable either way.
    }
    throw error
  }
}

/**
 * One debounced, atomic JSON store whose corrupt or missing file reads as empty.
 * @param {object} options - store wiring.
 * @param {string} options.path - absolute JSON path.
 * @param {() => object} options.empty - factory for the empty value.
 * @param {{ warn: (message: string) => void }} options.log - logger.
 * @returns {{ load: () => Promise<object>, schedule: () => void, flush: () => Promise<void> }} store handle.
 */
function createJsonStore({ path, empty, log }) {
  let value
  let loaded = false
  let loading
  let timer
  let dirty = false

  const load = async () => {
    if (loaded) return value
    if (loading !== undefined) return loading
    loading = (async () => {
      try {
        const text = await readFile(path, 'utf8')
        const parsed = JSON.parse(text)
        if (isRecord(parsed)) {
          value = { ...empty(), ...parsed }
          if (!isRecord(value.skills)) value.skills = {}
          if (Array.isArray(empty().recent) && !Array.isArray(value.recent)) value.recent = []
        } else {
          value = empty()
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') log.warn(`skill-dashboard: ignoring unreadable store ${basename(path)}: ${errorMessage(error)}`)
        value = empty()
      }
      loaded = true
      return value
    })()
    try {
      return await loading
    } finally {
      loading = undefined
    }
  }

  const flush = async () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!dirty || value === undefined) return
    dirty = false
    try {
      await writeJsonAtomic(path, value)
    } catch (error) {
      log.warn(`skill-dashboard: failed to save ${basename(path)}: ${errorMessage(error)}`)
    }
  }

  const schedule = () => {
    dirty = true
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, STORE_FLUSH_MS)
    timer.unref?.()
  }

  return { load, schedule, flush }
}

// ---------------------------------------------------------------------------
// Staged trees
// ---------------------------------------------------------------------------

/** Backoff schedule for transient move failures: five attempts in total. */
const MOVE_RETRY_DELAYS = [100, 200, 400, 800]

/**
 * Filesystem errors a file watcher, a search indexer, or an antivirus scan can
 * cause for a moment on Windows. Anything else fails the move immediately.
 */
const MOVE_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

/** Wait one backoff step. */
function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

/** A short random token for one staging or backup directory name. */
function randomToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Resolve the injectable filesystem seam used by every staged-tree operation. */
function resolveTreeIo(hooks = {}) {
  return {
    rename: hooks.rename ?? rename,
    copyFile: hooks.copyFile ?? copyFile,
    mkdir: hooks.mkdir ?? mkdir,
    readdir: hooks.readdir ?? readdir,
    rm: hooks.rm ?? rm,
    sleep: hooks.sleep ?? sleep,
  }
}

/**
 * Copy one tree into place file by file.
 * @param {string} source - directory to copy from.
 * @param {string} destination - directory to create.
 * @param {ReturnType<typeof resolveTreeIo>} io - filesystem seam.
 * @returns {Promise<{ ok: true } | { ok: false, error: unknown }>} outcome.
 */
async function copyTree(source, destination, io) {
  try {
    await io.mkdir(destination, { recursive: true })
    const entries = await io.readdir(source, { withFileTypes: true, encoding: 'utf8' })
    for (const entry of entries) {
      const from = join(source, entry.name)
      const to = join(destination, entry.name)
      if (entry.isDirectory()) {
        const nested = await copyTree(from, to, io)
        if (nested.ok !== true) return nested
        continue
      }
      if (!entry.isFile()) continue
      await io.copyFile(from, to)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Move one staged skill tree into its final directory.
 *
 * A freshly written directory inside a watched skill root can be held open by
 * the provider's Chokidar watcher (or a Windows indexer / AV) for a moment, and
 * the immediate `rename` then fails with EPERM/EBUSY — which is why every skill
 * tree is staged outside the watched roots first. The move retries those
 * transient codes with bounded backoff (100/200/400/800 ms, five attempts),
 * then falls back to copying file by file (which also covers a staging area on
 * another volume) and drops the staging tree. If even that fails, the partial
 * destination is removed, so a caller never leaves a half-written skill behind.
 *
 * @param {string} staging - absolute staging directory outside every skill root.
 * @param {string} destination - absolute target directory, expected to be absent.
 * @param {{ rename?: Function, copyFile?: Function, mkdir?: Function, readdir?: Function,
 *   rm?: Function, sleep?: Function, delays?: number[] }} [hooks] - injectable seam for tests.
 * @returns {Promise<{ ok: true, via: 'rename'|'copy', attempts: number } |
 *   { ok: false, code: string, message: string }>} outcome.
 */
export async function moveStagedTree(staging, destination, hooks = {}) {
  const io = resolveTreeIo(hooks)
  const delays = Array.isArray(hooks.delays) ? hooks.delays : MOVE_RETRY_DELAYS
  let lastError
  let attempts = 0
  for (let index = 0; index <= delays.length; index += 1) {
    attempts += 1
    try {
      await io.rename(staging, destination)
      return { ok: true, via: 'rename', attempts }
    } catch (error) {
      lastError = error
      if (!MOVE_RETRY_CODES.has(error?.code) || index === delays.length) break
      await io.sleep(delays[index])
    }
  }
  // Whatever kept the rename from landing, the staged bytes are still intact:
  // copy them in and give up on the original directory entry.
  try {
    await io.rm(destination, { recursive: true, force: true })
  } catch {
    // Nothing was created by a failed rename; a stale empty directory is harmless.
  }
  const copied = await copyTree(staging, destination, io)
  if (copied.ok === true) {
    try {
      await io.rm(staging, { recursive: true, force: true })
    } catch {
      // The staging tree is disposable.
    }
    return { ok: true, via: 'copy', attempts }
  }
  try {
    await io.rm(destination, { recursive: true, force: true })
  } catch {
    // Best effort: the caller reports the failure and cleans up its own tree.
  }
  return failure('write-failed', errorMessage(lastError ?? copied.error))
}

// ---------------------------------------------------------------------------
// Outbound HTTP
// ---------------------------------------------------------------------------

/** Bind one outbound request to the caller's signal and a hard timeout. */
function fenceSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted === true) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * One bounded outbound request returning text.
 * @param {string} url - absolute URL.
 * @param {{ signal?: AbortSignal, headers?: Record<string, string>, timeoutMs?: number, accept?: string }} [options] - request options.
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: string, message: string, status?: number }>} outcome.
 */
async function httpText(url, options = {}) {
  const fenced = fenceSignal(options.signal, options.timeoutMs ?? OUTBOUND_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: fenced.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: options.accept ?? 'text/plain, */*',
        ...(options.headers ?? {}),
      },
    })
    if (!response.ok) {
      const status = response.status
      const code = status === 429 ? 'source-rate-limited' : 'source-unavailable'
      return { ok: false, code, message: `${hostOf(url)} answered HTTP ${status}`, status }
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_OUTBOUND_BYTES) {
      return failure('source-unavailable', `${hostOf(url)} answered a payload larger than ${MAX_OUTBOUND_BYTES} bytes`)
    }
    const text = await response.text()
    if (text.length > MAX_OUTBOUND_BYTES) {
      return failure('source-unavailable', `${hostOf(url)} answered a payload larger than ${MAX_OUTBOUND_BYTES} bytes`)
    }
    return { ok: true, text }
  } catch (error) {
    const message =
      fenced.signal.aborted === true
        ? `${hostOf(url)} did not answer within ${OUTBOUND_TIMEOUT_MS / 1000}s`
        : `${hostOf(url)} could not be reached: ${errorMessage(error)}`
    return failure('source-unavailable', message)
  } finally {
    fenced.dispose()
  }
}

/** Fetch only a bounded byte prefix of one selected remote file, then cancel. */
async function httpPreviewFile(url, path, knownSize, signal) {
  const fenced = fenceSignal(signal, OUTBOUND_TIMEOUT_MS)
  let reader
  try {
    const response = await fetch(url, { signal: fenced.signal, redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream, */*' } })
    if (!response.ok) return failure(response.status === 429 ? 'source-rate-limited' : 'source-unavailable', `${hostOf(url)} answered HTTP ${response.status}`, { status: response.status })
    const declared = Number(response.headers.get('content-length'))
    const expected = Math.max(knownSize || 0, Number.isFinite(declared) && declared > 0 ? declared : 0)
    reader = response.body?.getReader()
    if (!reader) return { ok: true, file: previewContent(path, Buffer.alloc(0), expected) }
    const chunks = []
    let received = 0
    while (received <= MAX_PREVIEW_TEXT_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      const kept = value.subarray(0, MAX_PREVIEW_TEXT_BYTES + 1 - received)
      chunks.push(Buffer.from(kept))
      received += kept.length
    }
    const bytes = Buffer.concat(chunks, received)
    return { ok: true, file: previewContent(path, bytes.subarray(0, MAX_PREVIEW_TEXT_BYTES), Math.max(expected, received)) }
  } catch (error) {
    return failure('source-unavailable', `${hostOf(url)} could not be read: ${errorMessage(error)}`)
  } finally {
    try { await reader?.cancel() } catch { /* Disconnected streams need no cleanup. */ }
    fenced.dispose()
  }
}

/**
 * One bounded outbound request returning parsed JSON.
 * @param {string} url - absolute URL.
 * @param {{ signal?: AbortSignal, headers?: Record<string, string>, timeoutMs?: number }} [options] - request options.
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, code: string, message: string, status?: number }>} outcome.
 */
async function httpJson(url, options = {}) {
  const outcome = await httpText(url, { ...options, accept: 'application/json' })
  if (outcome.ok !== true) return outcome
  try {
    return { ok: true, value: JSON.parse(outcome.text) }
  } catch {
    return failure('source-unavailable', `${hostOf(url)} answered a payload that is not JSON`)
  }
}

/**
 * Run `worker` over `items` with bounded concurrency, stopping at the first failure.
 * @param {unknown[]} items - work items.
 * @param {number} limit - maximum parallel workers.
 * @param {(item: unknown, index: number) => Promise<{ ok: true, value?: unknown } | { ok: false, code: string, message: string }>} worker - one unit of work.
 * @returns {Promise<{ ok: true, results: unknown[] } | { ok: false, code: string, message: string }>} outcome.
 */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  let stopped
  const run = async () => {
    while (stopped === undefined) {
      const index = next
      next += 1
      if (index >= items.length) return
      let outcome
      try {
        outcome = await worker(items[index], index)
      } catch (error) {
        stopped = failure('source-unavailable', errorMessage(error))
        return
      }
      if (outcome.ok !== true) {
        stopped = outcome
        return
      }
      results[index] = outcome.value
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run)
  await Promise.all(workers)
  if (stopped !== undefined) return stopped
  return { ok: true, results }
}

/** Whether a registry path looks like a text file this plugin can install. */
function isTextualSkillFile(path) {
  const lowered = String(path).toLowerCase()
  if (lowered === 'skill.md' || lowered.endsWith('/skill.md')) return true
  const dot = lowered.lastIndexOf('.')
  return dot >= 0 && TEXT_EXTENSIONS.has(lowered.slice(dot))
}

/**
 * Cap a fetched file set by count and by total text size.
 * @param {{ path: string, text: string }[]} files - normalized files.
 * @returns {{ path: string, text: string }[]} the part that may be written.
 */
function boundFileSet(files) {
  const kept = []
  let bytes = 0
  for (const file of files) {
    if (kept.length >= MAX_INSTALL_FILES) break
    const size = Buffer.byteLength(file.text, 'utf8')
    if (bytes + size > MAX_INSTALL_BYTES) break
    bytes += size
    kept.push(file)
  }
  return kept
}

// ---------------------------------------------------------------------------
// Registry adapters
// ---------------------------------------------------------------------------

/**
 * Headers for one GitHub API request, authorized when the environment carries a
 * token: an authenticated client is not bound by the anonymous 60/hour fence.
 * @returns {Record<string, string>} request headers.
 */
function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const headers = { accept: 'application/vnd.github+json' }
  if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * The newest commit id in one GitHub atom feed.
 * @param {string} text - feed body.
 * @returns {string | null} 40-hex commit, or null when the feed carries none.
 */
function commitFromAtom(text) {
  const match = /tag:github\.com,2008:Grit::Commit\/([0-9a-f]{40})/i.exec(String(text))
  return match === null ? null : match[1].toLowerCase()
}

/** Encode a repository-relative path for one file URL, segment by segment. */
function encodeRepoPath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/')
}

/** One tiny TTL cache used for search results, repo trees, and skill payloads. */
function createCache(ttlMs, maxEntries = 64) {
  const entries = new Map()
  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      if (Date.now() - entry.at >= ttlMs) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value) {
      entries.set(key, { at: Date.now(), value })
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next()
        if (oldest.done !== true) entries.delete(oldest.value)
      }
    },
  }
}

/**
 * Normalize one Tencent SkillHub search hit into the CONTRACT §4 item shape.
 *
 * `name` must be the install identity — the kebab-case slug the registry
 * accepts as a skill name — never the Chinese display name, which travels in
 * `title` for the panel to show instead.
 */
function normalizeTencentHit(row) {
  if (!isRecord(row)) return undefined
  const slug = stringField(row, ['slug', 'id', 'skillSlug'])
  if (slug === undefined) return undefined
  const title = stringField(row, ['name', 'displayName', 'title'])
  return {
    id: slug,
    ref: slug,
    name: slug,
    ...(title === undefined || title === slug ? {} : { title }),
    description: stringField(row, ['description_zh', 'description', 'summary']) ?? '',
    source: 'tencent',
    version: stringField(row, ['version', 'latestVersion']) ?? null,
    updatedAt: stringField(row, ['updatedAt', 'updated_at', 'publishTime']) ?? null,
    installs: numberField(row, ['downloads', 'downloadCount', 'installs']),
    url: ENDPOINTS.tencent.page(slug),
  }
}

/** Normalize one skills.sh search hit into the CONTRACT §4 item shape. */
function normalizeSkillsShHit(row) {
  if (!isRecord(row)) return undefined
  const id = stringField(row, ['id'])
  const source = stringField(row, ['source', 'repo', 'repository'])
  const skillId = stringField(row, ['skillId', 'name'])
  const name = skillId ?? (typeof id === 'string' ? id.split('/').pop() : undefined)
  if (name === undefined) return undefined
  const ref = source ?? (typeof id === 'string' && id.split('/').length >= 2 ? id.split('/').slice(0, 2).join('/') : undefined)
  if (ref === undefined) return undefined
  return {
    id: id ?? `${ref}/${name}`,
    ref,
    name,
    description: stringField(row, ['description', 'summary']) ?? '',
    source: 'skills-sh',
    version: null,
    updatedAt: null,
    installs: numberField(row, ['installs', 'downloads']),
    url: ENDPOINTS['skills-sh'].page(id ?? ref),
  }
}

/**
 * Build the source table. Both adapters degrade to `source-unavailable` instead
 * of throwing, so a registry outage can never break the panel.
 *
 * @returns {Record<string, { id: string, title: string, search: Function, fetch: Function }>} adapters by source id.
 */
function createSources() {
  const searchCache = createCache(SEARCH_CACHE_MS)
  const treeCache = createCache(TREE_CACHE_MS, 32)
  const payloadCache = createCache(PAYLOAD_CACHE_MS, 32)
  const commitCache = createCache(COMMIT_CACHE_MS)
  const previewListingCache = createCache(PREVIEW_CACHE_MS, PREVIEW_CACHE_CAP)
  const previewFileCache = createCache(PREVIEW_CACHE_MS, PREVIEW_CACHE_CAP)

  /** Tencent SkillHub: search, list files, then fetch each raw file. */
  const tencent = {
    id: 'tencent',
    title: '腾讯 SkillHub',

    async search(query, signal) {
      const cached = searchCache.get(`tencent:${query}`)
      if (cached !== undefined) return { ok: true, items: cached }
      const outcome = await httpJson(ENDPOINTS.tencent.search(query), { signal })
      if (outcome.ok !== true) return outcome
      const payload = outcome.value
      if (isRecord(payload) && typeof payload.code === 'number' && payload.code !== 0) {
        return failure('source-unavailable', `腾讯 SkillHub answered code ${payload.code}`)
      }
      const rows = pickArray(payload, [['data', 'skills'], ['data', 'list'], ['data', 'items'], ['skills'], ['data']])
      if (rows === undefined) return failure('source-unavailable', '腾讯 SkillHub returned an unexpected search payload')
      const items = []
      for (const row of rows) {
        const item = normalizeTencentHit(row)
        if (item !== undefined) items.push(item)
      }
      searchCache.set(`tencent:${query}`, items)
      return { ok: true, items }
    },

    async fetch(locator, signal, hints = {}) {
      const slug = locator.slug
      const cached = hints.refresh === true ? undefined : payloadCache.get(`tencent:${slug}`)
      if (cached !== undefined) return cached
      const listing = await httpJson(ENDPOINTS.tencent.files(slug), { signal })
      if (listing.ok !== true) return listing
      const rows = pickArray(listing.value, [['data', 'files'], ['files'], ['data']])
      if (rows === undefined) return failure('source-unavailable', '腾讯 SkillHub returned no file list for this skill')
      const wanted = []
      let omittedOversize = false
      for (const row of rows) {
        const path = isRecord(row) ? stringField(row, ['path', 'name', 'filename']) : undefined
        if (path === undefined) continue
        if (!isTextualSkillFile(path)) continue
        const size = numberField(row, ['size', 'bytes'])
        if (size !== undefined && size > MAX_INSTALL_BYTES) {
          omittedOversize = true
          continue
        }
        wanted.push({ path, size })
      }
      if (wanted.length === 0) return failure('source-unavailable', 'this skill has no installable text files')
      // SKILL.md goes first so the per-set cap can never drop it.
      wanted.sort((left, right) => skillFileOrder(left.path) - skillFileOrder(right.path))
      const fetched = await mapWithLimit(wanted.slice(0, MAX_INSTALL_FILES), MAX_FILE_FETCH_CONCURRENCY, async (file) => {
        const raw = await httpText(ENDPOINTS.tencent.file(slug, file.path), { signal })
        if (raw.ok !== true) return raw
        return { ok: true, value: { path: file.path, text: raw.text } }
      })
      if (fetched.ok !== true) return fetched
      const files = boundFileSet(fetched.results)
      if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
        return failure('source-unavailable', 'this skill did not provide a SKILL.md')
      }
      const envelope = isRecord(listing.value) && isRecord(listing.value.data) ? listing.value.data : listing.value
      const result = {
        ok: true,
        files,
        version: stringField(envelope, ['version', 'latestVersion']) ?? null,
        truncatedFiles: omittedOversize || wanted.length > files.length,
      }
      payloadCache.set(`tencent:${slug}`, result)
      return result
    },
  }

  /**
   * Load (and cache) the blob paths of one GitHub repository at one revision.
   * Without a revision the two conventional default branches are probed.
   */
  const loadRepoTrees = async (owner, repo, rev, signal, refresh = false) => {
    const key = `${owner}/${repo}@${rev ?? ''}`
    const cached = refresh ? undefined : treeCache.get(key)
    if (cached !== undefined) return { ok: true, ...cached }
    let lastFailure
    for (const candidate of rev === undefined ? ['main', 'master'] : [rev]) {
      const outcome = await httpJson(ENDPOINTS['skills-sh'].tree(owner, repo, candidate), {
        signal,
        headers: githubHeaders(),
      })
      if (outcome.ok === true) {
        const tree = pickArray(outcome.value, [['tree'], ['data', 'tree']])
        if (tree === undefined) return failure('source-unavailable', 'GitHub returned an unexpected tree payload')
        const paths = tree
          .filter((entry) => isRecord(entry) && entry.type === 'blob' && typeof entry.path === 'string')
          .map((entry) => entry.path)
        const sizes = Object.fromEntries(tree.filter((entry) => isRecord(entry) && typeof entry.path === 'string' && Number.isFinite(entry.size)).map((entry) => [entry.path, entry.size]))
        const value = { rev: candidate, paths, sizes, truncated: outcome.value?.truncated === true }
        treeCache.set(key, value)
        return { ok: true, ...value }
      }
      lastFailure = outcome
      if (outcome.status !== 404) break
    }
    return lastFailure ?? failure('source-unavailable', 'the GitHub tree could not be read')
  }

  /**
   * Load one repository listing from jsDelivr's data API, which needs no token.
   *
   * It resolves branches and tags only, so a commit sha can never be served
   * this way, and it caches a branch for hours: the caller must not record a
   * pin for bytes that came from a listing it cannot date.
   */
  const loadFallbackTree = async (owner, repo, rev, signal) => {
    let lastFailure
    for (const candidate of rev === undefined ? ['main', 'master'] : [rev]) {
      const outcome = await httpJson(ENDPOINTS['skills-sh'].flat(owner, repo, candidate), { signal })
      if (outcome.ok === true) {
        const rows = pickArray(outcome.value, [['files'], ['data', 'files']])
        if (rows === undefined) return failure('source-unavailable', 'jsDelivr returned an unexpected file listing')
        const paths = []
        const sizes = {}
        for (const row of rows) {
          const listed = isRecord(row) ? stringField(row, ['name', 'path']) : undefined
          if (listed === undefined || listed.endsWith('/')) continue
          const path = listed.replace(/^\//, '')
          if (path.length === 0) continue
          paths.push(path)
          const size = numberField(row, ['size'])
          if (size !== undefined && size >= 0) sizes[path] = size
        }
        return { ok: true, rev: candidate, paths, sizes, truncated: false, degraded: true }
      }
      lastFailure = outcome
      if (outcome.status !== 404) break
    }
    return lastFailure ?? failure('source-unavailable', 'the repository file list could not be read')
  }

  /** Pick the shallowest `<name>/SKILL.md` directory inside one repository tree. */
  const pickSkillDirectory = (paths, name) => {
    const wanted = name.toLowerCase()
    const candidates = paths.filter((path) => {
      const segments = path.split('/')
      return segments[segments.length - 1].toLowerCase() === 'skill.md'
    })
    if (candidates.length === 0) return undefined
    const named = candidates.filter((path) => {
      const segments = path.split('/')
      return segments.length >= 2 && segments[segments.length - 2].toLowerCase() === wanted
    })
    const pool = named.length > 0 ? named : candidates
    pool.sort((left, right) => left.split('/').length - right.split('/').length || compareNames(left, right))
    const chosen = pool[0]
    const segments = chosen.split('/')
    segments.pop()
    return { directory: segments.join('/'), file: chosen }
  }

  /** Up to five `#path` candidates for a "which skill?" refusal. */
  const candidateList = (directories) => {
    const sorted = [...directories].sort(
      (left, right) => left.split('/').length - right.split('/').length || compareNames(left, right),
    )
    return sorted.slice(0, 5).map((directory) => `#${directory}`).join(', ')
  }

  /**
   * Choose one skill directory inside a repository tree: an explicit subpath, a
   * discovery card's name hint, a repository holding exactly one skill, or a
   * directory named after the reference. A repository holding several skills
   * with nothing to choose by is a question for the caller, not a guess.
   */
  const selectSkillDirectory = (paths, locator, nameHint) => {
    const directories = []
    for (const path of paths) {
      const segments = path.split('/')
      if (segments[segments.length - 1].toLowerCase() !== 'skill.md') continue
      segments.pop()
      directories.push(segments.join('/'))
    }
    const choose = (directory) => ({
      ok: true,
      directory,
      file: directory.length > 0 ? `${directory}/SKILL.md` : 'SKILL.md',
    })
    const where = `${locator.owner}/${locator.repo}`
    if (locator.path.length > 0) {
      const found = directories.find((directory) => directory.toLowerCase() === locator.path.toLowerCase())
      if (found !== undefined) return choose(found)
      return failure('subpath-required', `${where} has no SKILL.md at "${locator.path}"; candidates: ${candidateList(directories)}`)
    }
    if (nameHint !== undefined) {
      const picked = pickSkillDirectory(paths, nameHint)
      if (picked !== undefined) return { ok: true, ...picked }
    }
    if (directories.length === 1) return choose(directories[0])
    const named = directories.find((directory) => {
      const segments = directory.split('/')
      return segments[segments.length - 1].toLowerCase() === locator.name.toLowerCase()
    })
    if (named !== undefined) return choose(named)
    return failure(
      'subpath-required',
      `${where} holds several skills; name one as owner/repo#path (candidates: ${candidateList(directories)})`,
    )
  }

  /**
   * Read one repository file, preferring raw.githubusercontent and falling back
   * to jsDelivr's CDN. `cdn` marks a read the CDN served, which caches a branch
   * for hours: the caller must not claim a pin for those bytes.
   */
  const fetchRepoFile = async (owner, repo, rev, path, signal) => {
    const raw = await httpText(ENDPOINTS['skills-sh'].raw(owner, repo, rev, encodeRepoPath(path)), { signal })
    if (raw.ok === true) return raw
    const cdn = await httpText(ENDPOINTS['skills-sh'].cdn(owner, repo, rev, path), { signal })
    return cdn.ok === true ? { ...cdn, cdn: true } : cdn
  }

  /**
   * Resolve the commit one reference points at, or null when no channel names
   * one. A commit sha is its own answer, so a sha-pinned update never spends a
   * request here.
   */
  const loadCommit = async (owner, repo, rev, signal, refresh = false) => {
    if (isCommitRev(rev)) return rev
    const key = `${owner}/${repo}@${rev ?? ''}`
    const cached = refresh ? undefined : commitCache.get(key)
    if (cached !== undefined) return cached
    let commit = null
    const api = await httpJson(ENDPOINTS['skills-sh'].commits(owner, repo, rev), { signal, headers: githubHeaders() })
    const sha = api.ok === true && Array.isArray(api.value) ? api.value[0]?.sha : undefined
    if (isCommitRev(sha)) commit = sha
    else if (rev !== undefined) {
      // The atom feed needs a named revision and answers without the API host.
      const atom = await httpText(ENDPOINTS['skills-sh'].commitsAtom(owner, repo, rev), {
        signal,
        accept: 'application/atom+xml, */*',
      })
      if (atom.ok === true) commit = commitFromAtom(atom.text)
    }
    commitCache.set(key, commit)
    return commit
  }

  /** skills.sh: search the directory index, resolve a repo path, fetch raw files. */
  const skillsSh = {
    id: 'skills-sh',
    title: 'skills.sh',

    async search(query, signal) {
      const key = `skills-sh:${query}`
      const cached = searchCache.get(key)
      if (cached !== undefined) return { ok: true, items: cached }
      const outcome = await httpJson(ENDPOINTS['skills-sh'].search(query), { signal })
      if (outcome.ok !== true) return outcome
      const rows = pickArray(outcome.value, [['skills'], ['items'], ['results'], ['data']])
      if (rows === undefined) return failure('source-unavailable', 'skills.sh returned an unexpected search payload')
      const items = []
      for (const row of rows) {
        const item = normalizeSkillsShHit(row)
        if (item !== undefined) items.push(item)
      }
      searchCache.set(key, items)
      return { ok: true, items }
    },

    async fetch(locator, signal, hints = {}) {
      const { owner, repo, rev, path: subpath } = locator
      const nameHint = typeof hints.name === 'string' && hints.name.length > 0 ? hints.name : undefined
      // An update must read the upstream now; only an install may reuse a payload.
      const refresh = hints.refresh === true
      let tree = await loadRepoTrees(owner, repo, rev, signal, refresh)
      if (tree.ok !== true) {
        // A sha has no jsDelivr listing; guessing one would record a pin the
        // bytes never came from, so only a named branch degrades. A refused,
        // throttled, failed, or unreachable API host all degrade the same way:
        // a mainland network usually times out without an HTTP status at all.
        const retryable = tree.status === undefined || tree.status === 403 || tree.status === 429 || tree.status >= 500
        if (isCommitRev(rev) || !retryable) return tree
        tree = await loadFallbackTree(owner, repo, rev, signal)
        if (tree.ok !== true) return tree
      }
      // A branch payload is only valid for the tree it came from, so the tree
      // revision is part of its identity; a moved branch never serves old bytes.
      const cacheKey = `skills-sh:${owner}/${repo}@${tree.rev}#${subpath}#${nameHint ?? ''}`
      const cached = refresh ? undefined : payloadCache.get(cacheKey)
      if (cached !== undefined) return cached
      const picked = selectSkillDirectory(tree.paths, locator, nameHint)
      if (picked.ok !== true) return picked
      const prefix = picked.directory.length > 0 ? `${picked.directory}/` : ''
      // A repository-root skill ships only its own SKILL.md; a nested one ships
      // its whole directory subtree, textual files first and SKILL.md first.
      const wanted = (
        prefix.length === 0
          ? ['SKILL.md']
          : tree.paths
              .filter((path) => path.startsWith(prefix))
              .map((path) => path.slice(prefix.length))
              .filter((path) => path.length > 0 && isTextualSkillFile(path))
              .sort((left, right) => skillFileOrder(left) - skillFileOrder(right) || compareNames(left, right))
      )
      if (wanted.length === 0) return failure('source-unavailable', 'this skill has no installable text files')
      let servedByCdn = false
      const fetched = await mapWithLimit(wanted.slice(0, MAX_INSTALL_FILES), MAX_FILE_FETCH_CONCURRENCY, async (path) => {
        const file = await fetchRepoFile(owner, repo, tree.rev, `${prefix}${path}`, signal)
        if (file.ok !== true) return file
        if (file.cdn === true) servedByCdn = true
        return { ok: true, value: { path, text: file.text } }
      })
      if (fetched.ok !== true) return fetched
      const files = boundFileSet(fetched.results)
      if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
        return failure('source-unavailable', 'this skill did not provide a SKILL.md')
      }
      // A CDN-served branch caches for hours, so those bytes cannot be pinned to
      // the head commit the API named; the record says so instead of guessing.
      const commit = tree.degraded === true || servedByCdn ? null : await loadCommit(owner, repo, tree.rev, signal, refresh)
      const result = { ok: true, files, version: null, commit, truncatedFiles: tree.truncated === true || wanted.length > files.length }
      payloadCache.set(cacheKey, result)
      return result
    },

    /** Refresh one repository's tree once, so a check's skills share one fresh listing. */
    async warm(locator, signal) {
      const tree = await loadRepoTrees(locator.owner, locator.repo, locator.rev, signal, true)
      return tree.ok === true ? { ok: true } : tree
    },
  }

  /** Preview metadata and content have separate short caches; unopened files are never fetched. */
  const previewSource = async (sourceId, locator, signal, hints = {}) => {
    const key = `${sourceId}:${locator.ref}#${hints.name ?? ''}`
    let listing = hints.refresh ? undefined : previewListingCache.get(key)
    let fallbackFile
    if (listing === undefined) {
      let rows
      let version = null
      let rev
      let prefix = ''
      let upstreamTruncated = false
      if (sourceId === 'tencent') {
        const response = await httpJson(ENDPOINTS.tencent.files(locator.slug), { signal })
        if (!response.ok) return response
        rows = pickArray(response.value, [['data', 'files'], ['files'], ['data']])
        if (rows === undefined) return failure('source-unavailable', '腾讯 SkillHub returned no file list for this skill')
        const envelope = isRecord(response.value?.data) ? response.value.data : response.value
        version = stringField(envelope, ['version', 'latestVersion']) ?? null
        rows = rows.map((row) => ({ path: stringField(row, ['path', 'name', 'filename']), size: numberField(row, ['size', 'bytes']) }))
      } else {
        const { owner, repo } = locator
        const tree = await loadRepoTrees(owner, repo, locator.rev, signal, hints.refresh)
        if (!tree.ok) {
          // Keep the conventional-layout fallback lazy, too: probe only SKILL.md.
          if (tree.status !== 403 && tree.status !== 429) return tree
          const directories = locator.path.length > 0 ? [locator.path] : [hints.name ?? locator.name, '']
          for (const fallbackRev of locator.rev === undefined ? ['main', 'master'] : [locator.rev]) {
            for (const directory of directories) {
              const url = ENDPOINTS['skills-sh'].raw(owner, repo, fallbackRev, `${directory ? `${directory}/` : ''}SKILL.md`)
              const file = await httpPreviewFile(url, 'SKILL.md', 0, signal)
              if (!file.ok) continue
              listing = { files: [previewMetadata('SKILL.md', file.file.size)], version: null,
                rev: fallbackRev, prefix: directory ? `${directory}/` : '', truncatedFiles: true }
              fallbackFile = file.file
              break
            }
            if (listing) break
          }
          if (!listing) return failure('source-rate-limited', 'GitHub refused the repository tree; try again later')
        } else {
          const picked = selectSkillDirectory(tree.paths, locator, hints.name)
          if (!picked.ok) return picked
          rev = tree.rev
          prefix = picked.directory ? `${picked.directory}/` : ''
          rows = tree.paths.filter((path) => path.startsWith(prefix)).map((path) => ({ path: path.slice(prefix.length), size: tree.sizes?.[path] }))
          upstreamTruncated = tree.truncated
        }
      }
      if (!listing) {
        const files = []
        const seen = new Set()
        for (const row of rows) {
          const path = previewRelativePath(row.path)
          if (!path || seen.has(path)) continue
          if (path.split('/').length > MAX_PREVIEW_DEPTH + 1) {
            upstreamTruncated = true
            continue
          }
          seen.add(path)
          files.push(previewMetadata(path, Number.isFinite(row.size) && row.size >= 0 ? row.size : 0))
        }
        files.sort((a, b) => skillFileOrder(a.path) - skillFileOrder(b.path))
        if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) return failure('source-unavailable', 'this skill did not provide a SKILL.md')
        listing = { files: files.slice(0, MAX_INSTALL_FILES), version, rev, prefix,
          truncatedFiles: upstreamTruncated === true || files.length > MAX_INSTALL_FILES }
      }
      listing.generation = randomToken()
      previewListingCache.set(key, listing)
    }
    const selected = hints.file ?? listing.files.find((file) => file.path.toLowerCase() === 'skill.md')?.path
    const metadata = listing.files.find((file) => file.path === selected)
    if (!metadata) return failure('file-not-found', 'file is not available in this source preview')
    const fileCacheKey = `${key}:${listing.generation}:${selected}`
    let file = hints.refresh ? undefined : previewFileCache.get(fileCacheKey)
    if (selected === 'SKILL.md' && fallbackFile) file = fallbackFile
    if (!file) {
      if (metadata.kind === 'binary') file = { ...metadata, content: null, truncated: false }
      else {
        const url = sourceId === 'tencent'
          ? ENDPOINTS.tencent.file(locator.slug, selected)
          : ENDPOINTS['skills-sh'].raw(locator.owner, locator.repo, listing.rev, encodeRepoPath(`${listing.prefix}${selected}`))
        const response = await httpPreviewFile(url, selected, metadata.size, signal)
        if (!response.ok) return response
        file = response.file
      }
    }
    if (fallbackFile || !previewFileCache.get(fileCacheKey)) previewFileCache.set(fileCacheKey, file)
    Object.assign(metadata, { size: file.size, kind: file.kind })
    if (selected.toLowerCase() === 'skill.md' && file.kind === 'text') {
      const parsed = parseSkillFrontmatter(file.content)
      if (parsed.ok) listing.skill = { name: parsed.name, description: parsed.description }
    }
    return { ok: true, files: listing.files, file, version: listing.version,
      skill: listing.skill, truncatedFiles: listing.truncatedFiles }
  }
  tencent.preview = (locator, signal, hints) => previewSource('tencent', locator, signal, hints)
  skillsSh.preview = (locator, signal, hints) => previewSource('skills-sh', locator, signal, hints)
  return { 'skills-sh': skillsSh, tencent }
}

/** Order one file set so SKILL.md is fetched (and therefore capped) first. */
function skillFileOrder(path) {
  return String(path).toLowerCase() === 'skill.md' ? 0 : 1
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Host entry point: registers the four exact routes, the usage listeners, and
 * the two JSON stores. Every registration is an effect owned by this plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 */
export function apply(ctx) {
  const log = {
    info: (message) => {
      try {
        ctx.logger?.info(message)
      } catch {
        // Logging must never take the plugin down.
      }
    },
    warn: (message) => {
      try {
        ctx.logger?.warn(message)
      } catch {
        // Logging must never take the plugin down.
      }
    },
  }

  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const agentsHome =
    process.env.DSH_AGENTS_HOME && process.env.DSH_AGENTS_HOME.length > 0
      ? process.env.DSH_AGENTS_HOME
      : join(homedir(), '.agents')

  /**
   * The real spelling of one path, when it can be resolved.
   *
   * Windows exposes a directory through both its 8.3 short form and its long
   * form, and the catalog may report either. Comparing a resolved target
   * against an unresolved root would then fail to recognise the same
   * directory, so every containment check compares resolved spellings.
   *
   * @param {string} path - a path to resolve.
   * @returns {Promise<string>} the resolved path, or the input when it cannot be resolved.
   */
  const resolvedPath = async (path) => {
    try {
      return await realpath(path)
    } catch {
      return path
    }
  }

  const usageStore = createJsonStore({
    path: join(dshHome, 'skill-dashboard', 'usage.json'),
    empty: emptyUsageStore,
    log,
  })
  const installedStore = createJsonStore({
    path: join(dshHome, 'skill-dashboard', 'installed.json'),
    empty: emptyInstalledStore,
    log,
  })
  const updatesStore = createJsonStore({
    path: join(dshHome, 'skill-dashboard', 'updates.json'),
    empty: emptyUpdatesStore,
    log,
  })

  /** Mutable per-activation state; nothing here survives a plugin reload. */
  const stateCache = {
    data: null,
    builtAt: 0,
    inFlight: null,
    dirty: false,
    invalidateTimer: null,
    warmupTimer: null,
  }
  let stateVersion = 0
  let dirtyVersion = 0

  const runtime = {
    disposed: false,
    runtimeCache: undefined,
    runtimeCacheAt: 0,
    statePresence: new Map(),
    recentEdits: new Map(),
  }

  const sources = createSources()
  const localPreviewCache = createCache(PREVIEW_CACHE_MS, PREVIEW_CACHE_CAP)

  /** Portable provenance record written inside every installed skill directory. */
  const PROVENANCE_FILE = '.skill-source.json'

  // ------------------------------------------------------------------ paths

  /** Installation roots that must stay read-only for this plugin. */
  const installRoots = () => {
    const roots = new Set()
    if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) roots.add(dirname(process.resourcesPath))
    if (typeof process.execPath === 'string' && process.execPath.length > 0) roots.add(dirname(process.execPath))
    if (process.env.DSH_INSTALL_DIR) roots.add(process.env.DSH_INSTALL_DIR)
    return [...roots]
  }

  /**
   * Installation roots in their real spelling.
   *
   * Windows names one directory both by its 8.3 short form and by its long
   * form, and `realpath` returns the long one. Comparing a resolved target
   * against unresolved roots would miss the installation, so roots are
   * resolved before any containment check.
   *
   * @returns {Promise<string[]>} resolved installation roots.
   */
  const resolvedInstallRoots = async () =>
    Promise.all(
      installRoots().map(async (root) => {
        try {
          return await realpath(root)
        } catch {
          // A root that cannot be resolved is still compared by name.
          return root
        }
      }),
    )

  /** Working directory the Host serves, when the profile mounts that service. */
  const workspaceDirectory = () => {
    const service = ctx.get('workingDirectory')
    const directory = service?.defaultDirectory
    return typeof directory === 'string' && directory.length > 0 ? directory : undefined
  }

  /** Existing skill roots in precedence order, with their source labels. */
  const knownSkillRoots = () => {
    const roots = []
    const cwd = workspaceDirectory()
    if (cwd !== undefined) {
      roots.push({ path: join(cwd, '.dsh', 'skills'), source: 'project-dsh' })
      roots.push({ path: join(cwd, '.agents', 'skills'), source: 'project-agents' })
    }
    roots.push({ path: join(dshHome, 'skills'), source: 'user-dsh' })
    roots.push({ path: join(agentsHome, 'skills'), source: 'user-agents' })
    return roots
  }

  /** Default install root for a pulled skill: the user agents root. */
  const installRoot = () => join(agentsHome, 'skills')

  /** Skill roots a dashboard mutation may touch, including ones the catalog reported. */
  const writableSkillRoots = () => {
    const seen = new Map()
    const add = (path) => {
      if (typeof path !== 'string' || path.length === 0) return
      if (!isAbsolute(path)) return
      if (isProtectedInstallPath(path, installRoots())) return
      const key = normalizePathKey(path)
      if (key.length === 0 || seen.has(key)) return
      seen.set(key, path)
    }
    for (const root of knownSkillRoots()) add(root.path)
    for (const skill of stateCache.data?.skills ?? []) {
      if (skill?.writable !== true) continue
      if (typeof skill.path !== 'string') continue
      add(skill.dir !== null && typeof skill.dir === 'string' ? dirname(skill.dir) : dirname(skill.path))
    }
    return [...seen.values()]
  }

  /** Source label of one absolute root path. */
  const sourceOfRoot = (root) => {
    const key = normalizePathKey(root)
    for (const known of knownSkillRoots()) if (normalizePathKey(known.path) === key) return known.source
    const leaf = basename(root).toLowerCase()
    if (leaf === 'skills') {
      const parent = basename(dirname(root)).toLowerCase()
      if (parent === '.dsh') return 'project-dsh'
      if (parent === '.agents') return 'project-agents'
    }
    return 'custom'
  }

  // ------------------------------------------------------------------ usage

  /** Resolve the calling agent for one tool execution, falling back to its session id. */
  const agentIdOf = (exec) => {
    const agent = exec?.agent
    if (agent === undefined || agent === null) return 'default'
    const presets = ctx.get('agentPresets')
    if (presets !== undefined && typeof presets.presetForSession === 'function') {
      for (const candidate of [agent.session, agent]) {
        if (candidate === undefined) continue
        try {
          const preset = presets.presetForSession(candidate)
          if (typeof preset === 'string' && preset.length > 0) return preset
        } catch {
          // An unreadable projection is not an error: fall back to the SessionId.
        }
      }
    }
    return typeof agent.id === 'string' && agent.id.length > 0 ? agent.id : 'default'
  }

  /** Record one observation and schedule the debounced flush. */
  const recordUsage = (name, agentId, sessionId, channel) => {
    if (runtime.disposed) return
    void (async () => {
      try {
        const state = await usageStore.load()
        applyUsageEvent(state, { name, agentId, sessionId, channel, at: Date.now() })
        usageStore.schedule()
      } catch (error) {
        log.warn(`skill-dashboard: usage recording failed: ${errorMessage(error)}`)
      }
    })()
  }

  /** Usage summary for one skill, read from the loaded store. */
  const usageForSkill = (state, name, now) => summarizeSkillUsage(isRecord(state?.skills) ? state.skills[name] : undefined, now)

  // --------------------------------------------------------------- catalogs

  /** Release one preset scope lease however that revision exposes disposal. */
  const disposeLease = async (lease) => {
    if (lease === undefined || lease === null) return
    const asyncDispose = lease[Symbol.asyncDispose]
    if (typeof asyncDispose === 'function') {
      await asyncDispose.call(lease)
      return
    }
    if (typeof lease.dispose === 'function') await lease.dispose.call(lease)
  }

  /** View options shared by every catalog read. */
  const viewOptions = (scope) => {
    const options = {}
    if (scope !== undefined) options.scope = scope
    const cwd = workspaceDirectory()
    if (cwd !== undefined) options.cwd = cwd
    return options
  }

  /**
   * Read the Agent preset roster, preferring the export shape CONTRACT §4 needs.
   * @returns {Promise<{ id: string, title: string, description?: string, isDefault: boolean }[]>} roster, or [].
   */
  const readAgentRoster = async () => {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) return []
    let rows
    try {
      if (typeof presets.remoteExportList === 'function') {
        const roster = await presets.remoteExportList()
        rows = Array.isArray(roster?.presets) ? roster.presets : undefined
      }
      if (rows === undefined && typeof presets.list === 'function') rows = await presets.list()
    } catch (error) {
      log.warn(`skill-dashboard: agent preset roster read failed: ${errorMessage(error)}`)
      rows = undefined
    }
    if (!Array.isArray(rows)) return []
    const agents = []
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) continue
      agents.push({
        id: row.id,
        title: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
        ...(typeof row.description === 'string' && row.description.length > 0 ? { description: row.description } : {}),
        isDefault: row.isDefault === true,
      })
    }
    if (agents.length > 0 && !agents.some((agent) => agent.isDefault)) agents[0].isDefault = true
    return agents
  }

  /** Read one preset's scoped catalog, never leaking the lease and never throwing. */
  const readScopedCatalog = async (agentId) => {
    const presets = ctx.get('agentPresets')
    if (presets === undefined || typeof presets.acquireScope !== 'function') return undefined
    let lease
    try {
      lease = await presets.acquireScope(agentId)
      return await ctx.skills.list(viewOptions(lease?.key))
    } catch (error) {
      log.warn(`skill-dashboard: preset "${agentId}" catalog read failed: ${errorMessage(error)}`)
      return undefined
    } finally {
      try {
        await disposeLease(lease)
      } catch (error) {
        log.warn(`skill-dashboard: preset "${agentId}" scope release failed: ${errorMessage(error)}`)
      }
    }
  }

  /**
   * Scan the known skill roots directly, one level deep.
   *
   * This is the safety net for a profile whose skill provider is mounted per
   * preset: when every scoped read fails the panel must still list what is on
   * disk rather than showing an empty install.
   */
  const scanKnownRoots = async () => {
    const found = []
    for (const root of knownSkillRoots()) {
      if (found.length >= MAX_FALLBACK_SKILLS) break
      let entries
      try {
        entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        continue
      }
      entries.sort((left, right) => compareNames(left.name, right.name))
      for (const entry of entries) {
        if (found.length >= MAX_FALLBACK_SKILLS) break
        if (entry.name === '.system') continue
        const directory = entry.isDirectory()
        let filePath
        if (directory) filePath = join(root.path, entry.name, 'SKILL.md')
        else if (entry.isFile() && entry.name.endsWith('.md')) filePath = join(root.path, entry.name)
        if (filePath === undefined) continue
        let text
        try {
          text = await readFile(filePath, 'utf8')
        } catch {
          continue
        }
        const parsed = parseSkillFrontmatter(text)
        if (parsed.ok !== true) continue
        found.push({
          name: parsed.name,
          description: parsed.description,
          ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
          invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
          source: root.source,
          provider: 'filesystem',
          path: filePath,
        })
      }
    }
    return found
  }

  /**
   * Whether a real skill file exists at `path` and may be edited, plus when
   * that file was created. The creation time is an observation window for
   * diagnosis only and never travels in the state document.
   *
   * @param {string} path - absolute skill file path.
   * @returns {Promise<{ writable: boolean, createdAt: number }>} permission and creation instant (0 when unknown).
   */
  const resolveWritable = async (path, protectedRoots) => {
    if (typeof path !== 'string' || path.length === 0) return { writable: false, createdAt: 0 }
    try {
      const real = await realpath(path)
      const info = await stat(real)
      if (!info.isFile()) return { writable: false, createdAt: 0 }
      const birth = Number(info.birthtimeMs)
      const roots = Array.isArray(protectedRoots) ? protectedRoots : await resolvedInstallRoots()
      return {
        writable: !isProtectedInstallPath(real, roots),
        createdAt: Number.isFinite(birth) && birth > 0 ? birth : 0,
      }
    } catch {
      return { writable: false, createdAt: 0 }
    }
  }

  /** Drop a recent-edit overlay once it is older than the watcher-lag window. */
  const pruneRecentEdits = (now) => {
    for (const [key, edit] of runtime.recentEdits) {
      if (now - edit.at >= RECENT_EDIT_TTL_MS) runtime.recentEdits.delete(key)
    }
  }

  /** Apply still-fresh local writes over the values a catalog read returned. */
  const overlayRecentEdits = (skills) => {
    if (runtime.recentEdits.size === 0) return skills
    for (const skill of skills) {
      if (typeof skill.path !== 'string') continue
      const edit = runtime.recentEdits.get(normalizePathKey(skill.path))
      if (edit === undefined) continue
      skill.modelInvocable = edit.modelInvocable
      skill.userInvocable = edit.userInvocable
    }
    return skills
  }

  /** The catalog a profile without a usable preset layer still has to show. */
  const readGlobalCatalog = async () => {
    let catalog
    try {
      catalog = await ctx.skills.list(viewOptions())
    } catch (error) {
      log.warn(`skill-dashboard: unscoped catalog read failed: ${errorMessage(error)}`)
      catalog = undefined
    }
    if (Array.isArray(catalog) && catalog.length > 0) return catalog
    try {
      return await scanKnownRoots()
    } catch (error) {
      log.warn(`skill-dashboard: direct skill root scan failed: ${errorMessage(error)}`)
      return []
    }
  }

  /** Read the portable provenance record inside one installed skill directory. */
  const readProvenanceInDirectory = async (directory) => {
    if (typeof directory !== 'string' || directory.length === 0) return undefined
    try {
      const parsed = JSON.parse(await readFile(join(directory, PROVENANCE_FILE), 'utf8'))
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** Normalize one stored provenance record into the state's `installed` field. */
  const describeProvenance = (record) => {
    if (!isRecord(record)) return null
    const source = typeof record.source === 'string' && record.source.length > 0 ? record.source : null
    const ref = typeof record.ref === 'string' && record.ref.length > 0 ? record.ref : null
    if (source === null || ref === null) return null
    return {
      source,
      ref,
      version: typeof record.version === 'string' && record.version.length > 0 ? record.version : null,
      installedAt: Number.isFinite(record.installedAt) ? record.installedAt : null,
    }
  }

  /** Parsed `.skill-lock.json`, reused for five seconds; a rewrite changes its mtime and wins. */
  const skillLockCache = { value: null, mtimeMs: -1, at: 0 }

  /** Read the skills CLI's lock file, or null when it is missing or unreadable. */
  const readSkillLock = async () => {
    const path = join(agentsHome, '.skill-lock.json')
    const now = Date.now()
    let mtimeMs
    try {
      mtimeMs = (await stat(path)).mtimeMs
    } catch {
      skillLockCache.value = null
      skillLockCache.mtimeMs = -1
      skillLockCache.at = now
      return null
    }
    if (skillLockCache.at !== 0 && now - skillLockCache.at < LOCK_CACHE_MS && skillLockCache.mtimeMs === mtimeMs) {
      return skillLockCache.value
    }
    let value = null
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      if (isRecord(parsed) && isRecord(parsed.skills)) value = parsed
    } catch {
      // A malformed lock is no provenance, not an error.
    }
    skillLockCache.value = value
    skillLockCache.mtimeMs = mtimeMs
    skillLockCache.at = now
    return value
  }

  /**
   * Provenance for one catalog entry.
   *
   * `installed.json` is the source of truth, but its record is only borrowed
   * when its stored directory is the directory this entry resolved to — a
   * same-named skill in another root must never inherit someone else's record.
   * Fallback: the skill's own `.skill-source.json`, which cannot be ambiguous,
   * then the skills CLI's lock file, which maps by name and is re-validated
   * against the skill's exact install directory.
   */
  const provenanceOf = async (skill, installedState) => {
    const name = typeof skill?.name === 'string' ? skill.name : ''
    if (name.length === 0) return null
    const directory = typeof skill.dir === 'string' && skill.dir.length > 0 ? skill.dir : null
    const skills = isRecord(installedState?.skills) ? installedState.skills : {}
    const record = Object.hasOwn(skills, name) ? skills[name] : undefined
    if (isRecord(record)) {
      const storedPath = typeof record.path === 'string' && record.path.length > 0 ? record.path : null
      const proven =
        storedPath === null || (directory !== null && normalizePathKey(storedPath) === normalizePathKey(directory))
      if (proven) return describeProvenance(record)
    }
    const sidecar = describeProvenance(await readProvenanceInDirectory(directory))
    if (sidecar !== null) return sidecar
    return lockProvenanceOf(skill, await readSkillLock(), installRoot())
  }

  /**
   * Detect the coding agents that read the skill directories, cached for a
   * short while so a burst of UI fetches scans the roots once.
   *
   * @param {{ name: string, dir: string | null }[]} skills - catalog skills.
   * @param {boolean} [cache] - whether a full-catalog answer may be reused, and stored. A caller
   *   with a partial catalog passes false so it cannot overwrite the full answer.
   * @returns {Promise<{ runtimes: { id: string, title: string, skills: string[] }[], bySkill: Map<string, string[]> }>} detected runtimes.
   */
  const detectRuntimes = async (skills, cache = true) => {
    const now = Date.now()
    if (cache && runtime.runtimeCache !== undefined && now - runtime.runtimeCacheAt < RUNTIME_CACHE_MS) {
      return runtime.runtimeCache
    }
    const detected = await detectAgentRuntimes({
      home: homedir(),
      cwd: workspaceDirectory() ?? process.cwd(),
      agentsHome,
      dshHome,
      skills,
    })
    if (cache) {
      runtime.runtimeCache = detected
      runtime.runtimeCacheAt = now
    }
    return detected
  }

  /** Build the CONTRACT §4 state document from the live catalog and the stores. */
  const buildState = async () => {
    const now = Date.now()
    pruneRecentEdits(now)
    const [usageState, roster, installedState, protectedRoots, updatesState] = await Promise.all([
      usageStore.load(),
      readAgentRoster(),
      installedStore.load(),
      resolvedInstallRoots(),
      updatesStore.load(),
    ])
    const lists = []
    if (roster.length > 0) {
      const catalogs = await Promise.all(roster.map((agent) => readScopedCatalog(agent.id)))
      for (let index = 0; index < roster.length; index += 1) {
        const catalog = catalogs[index]
        if (catalog !== undefined) lists.push({ id: roster[index].id, skills: catalog })
      }
    }
    let agents = roster
    const collected = lists.reduce((total, list) => total + list.skills.length, 0)
    if (collected === 0) {
      // The shipped filesystem provider is mounted per preset, so an unscoped
      // read returns nothing and a failed profile returns less. Never show an
      // empty panel when skills exist on disk: fall back to one default agent.
      const catalog = await readGlobalCatalog()
      if (catalog.length > 0 || lists.length === 0) {
        agents = [DEFAULT_AGENT]
        lists.length = 0
        lists.push({ id: DEFAULT_AGENT.id, skills: catalog })
      }
    }
    const merged = mergeAgentSkills(lists, { usageOf: (name) => usageForSkill(usageState, name, now) })
    overlayRecentEdits(merged)
    const presence = new Map()
    await Promise.all(
      merged.map(async (skill) => {
        const file = await resolveWritable(skill.path, protectedRoots)
        skill.writable = file.writable
        if (file.createdAt > 0) presence.set(skill.name, file.createdAt)
        skill.installed = await provenanceOf(skill, installedState)
      }),
    )
    const detected = await detectRuntimes(merged.map((skill) => ({ name: skill.name, dir: skill.dir })))
    for (const skill of merged) {
      skill.runtimes = detected.bySkill.get(skill.name) ?? ['dsh']
    }
    const runtimes = detected.runtimes.map((entry) => ({ id: entry.id, title: entry.title, skillCount: entry.skills.length }))
    if (stampUsage(usageState, merged, presence, now)) usageStore.schedule()
    return {
      presence,
      snapshot: {
        ok: true,
        generatedAt: now,
        agents,
        runtimes,
        skills: merged,
        usage: summarizeUsage(usageState, now),
        diagnosis: diagnoseSkills(merged, usageState, { now, since: usageState.since, presence }),
        updates: describeUpdates(updatesState, merged),
        sources: Object.values(sources).map((source) => ({
          id: source.id,
          title: source.title,
          status: 'ready',
          note: null,
        })),
      },
    }
  }

  /** Run at most one coalesced state build, ignoring results superseded by invalidation. */
  const startStateBuild = () => {
    if (stateCache.inFlight !== null) return stateCache.inFlight
    const buildVersion = stateVersion
    const buildDirtyVersion = dirtyVersion
    const pending = (async () => {
      try {
        const { snapshot, presence } = await buildState()
        if (!runtime.disposed && buildVersion === stateVersion) {
          stateCache.data = snapshot
          stateCache.builtAt = Date.now()
          runtime.statePresence = presence
          if (dirtyVersion === buildDirtyVersion) stateCache.dirty = false
        }
        return snapshot
      } finally {
        if (stateCache.inFlight === pending) stateCache.inFlight = null
      }
    })()
    stateCache.inFlight = pending
    return pending
  }

  /**
   * Serve the merged state.
   *
   * Fresh snapshots return immediately; stale or dirty snapshots return the
   * cached document immediately while coalescing one background rebuild; cold
   * or forced reads await a fresh build.
   */
  const getState = async (options = {}) => {
    const force = typeof options === 'boolean' ? options : options?.force === true
    const now = Date.now()
    if (!force && !stateCache.dirty && stateCache.data !== null && now - stateCache.builtAt < STATE_TTL_MS) {
      return stateCache.data
    }
    if (!force && stateCache.data !== null) {
      if (!runtime.disposed && stateCache.inFlight === null) void startStateBuild().catch(() => {})
      return stateCache.data
    }
    if (force) {
      stateVersion += 1
      stateCache.inFlight = null
    }
    return startStateBuild()
  }

  /** Forget the cached state immediately; the next read awaits a fresh scan. */
  const invalidateState = () => {
    if (stateCache.invalidateTimer !== null) {
      clearTimeout(stateCache.invalidateTimer)
      stateCache.invalidateTimer = null
    }
    stateVersion += 1
    stateCache.data = null
    stateCache.builtAt = 0
    stateCache.inFlight = null
    stateCache.dirty = false
    runtime.statePresence = new Map()
    runtime.runtimeCache = undefined
    runtime.runtimeCacheAt = 0
  }

  /** Mark state dirty immediately and debounce provider-change refreshes. */
  const scheduleStateInvalidation = () => {
    if (runtime.disposed) return
    dirtyVersion += 1
    stateCache.dirty = true
    if (stateCache.invalidateTimer !== null) clearTimeout(stateCache.invalidateTimer)
    stateCache.invalidateTimer = setTimeout(() => {
      stateCache.invalidateTimer = null
      if (runtime.disposed) return
      runtime.runtimeCache = undefined
      runtime.runtimeCacheAt = 0
      if (stateCache.inFlight !== null) {
        void stateCache.inFlight.catch(() => {}).finally(() => {
          if (!runtime.disposed && stateCache.dirty && stateCache.inFlight === null) {
            void startStateBuild().catch(() => {})
          }
        })
        return
      }
      void startStateBuild().catch(() => {})
    }, STATE_INVALIDATE_DEBOUNCE_MS)
    stateCache.invalidateTimer.unref?.()
  }

  /** Find one skill entry in the cached state by absolute path. */
  const findCachedSkill = (path) => {
    if (typeof path !== 'string' || stateCache.data === null) return undefined
    const key = normalizePathKey(path)
    return stateCache.data.skills.find((skill) => typeof skill.path === 'string' && normalizePathKey(skill.path) === key)
  }

  // ----------------------------------------------------------------- writes

  /** One atomic file write that never leaves a half-written SKILL.md behind. */
  const writeTextAtomic = async (path, text) => {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, text, 'utf8')
      await rename(temporary, path)
    } catch (error) {
      try {
        await rm(temporary, { force: true })
      } catch {
        // The temp file is disposable either way.
      }
      throw error
    }
  }

  /**
   * The writable root that owns one target, comparing resolved spellings.
   *
   * A root and the target may name the same directory through different
   * Windows spellings, so both sides are resolved before containment is
   * checked. The unresolved root is returned because it is the path the
   * caller should report.
   *
   * @param {readonly string[]} roots - candidate writable roots.
   * @param {string} absolute - the requested path, resolved.
   * @param {string} real - the requested path with symlinks resolved.
   * @returns {Promise<string | undefined>} the owning root, if any.
   */
  const findWritableRoot = async (roots, absolute, real) => {
    for (const candidate of roots) {
      const resolved = await resolvedPath(candidate)
      // The resolved spellings decide containment: a root and its target may
      // name the same directory differently, and only the resolved forms of
      // both sides are comparable.
      if (isInsidePath(resolved, real) || isInsidePath(resolved, absolute)) return candidate
      if (isInsidePath(candidate, real) || isInsidePath(candidate, absolute)) return candidate
    }
    return undefined
  }

  /**
   * Verify that one absolute path may be edited or deleted by this plugin.
   *
   * Windows reports the same directory through two spellings — the 8.3 short
   * form and the long form — and `realpath` returns the long one. Comparing a
   * resolved target against unresolved roots would therefore reject skills the
   * plugin itself installed, so every root is resolved before the comparison.
   *
   * @param {string} requested - absolute path from the request body.
   * @returns {Promise<{ ok: true, real: string, target: string, kind: 'file'|'directory', root: string } |
   *   { ok: false, status: number, code: string, message: string }>} resolved target or a refusal.
   */
  const assertManageableTarget = async (requested) => {
    if (typeof requested !== 'string' || requested.length === 0) {
      return { ok: false, status: 400, code: 'bad-request', message: 'path is required' }
    }
    if (!isAbsolute(requested)) {
      return { ok: false, status: 400, code: 'bad-request', message: 'path must be absolute' }
    }
    const absolute = resolve(requested)
    let info
    try {
      info = await stat(absolute)
    } catch {
      return { ok: false, status: 404, code: 'not-found', message: 'the skill file no longer exists' }
    }
    let real
    try {
      real = await realpath(absolute)
    } catch {
      return { ok: false, status: 404, code: 'not-found', message: 'the skill file cannot be resolved' }
    }
    if (isProtectedInstallPath(real, await resolvedInstallRoots())) {
      return { ok: false, status: 403, code: 'read-only', message: 'this skill is part of the DSH installation' }
    }
    const roots = writableSkillRoots()
    const root = await findWritableRoot(roots, absolute, real)
    if (root === undefined) {
      return {
        ok: false,
        status: 403,
        code: 'read-only',
        message: 'this skill does not live in a writable skill root',
      }
    }
    if (info.isFile()) {
      return {
        ok: true,
        real,
        target: basename(absolute).toLowerCase() === 'skill.md' ? dirname(absolute) : absolute,
        kind: basename(absolute).toLowerCase() === 'skill.md' ? 'directory' : 'file',
        root,
      }
    }
    if (info.isDirectory()) {
      try {
        await stat(join(absolute, 'SKILL.md'))
      } catch {
        return { ok: false, status: 400, code: 'not-a-skill', message: 'this directory has no SKILL.md' }
      }
      return { ok: true, real, target: absolute, kind: 'directory', root }
    }
    return { ok: false, status: 400, code: 'not-a-skill', message: 'this path is neither a skill directory nor a Markdown file' }
  }

  // ---------------------------------------------------------------- actions

  /** `set-invocation`: rewrite the two frontmatter keys of one skill. */
  const setInvocation = async (body) => {
    if (body.modelInvocable !== undefined && typeof body.modelInvocable !== 'boolean') {
      return { status: 400, body: failure('bad-request', 'modelInvocable must be a boolean') }
    }
    if (body.userInvocable !== undefined && typeof body.userInvocable !== 'boolean') {
      return { status: 400, body: failure('bad-request', 'userInvocable must be a boolean') }
    }
    if (body.modelInvocable === undefined && body.userInvocable === undefined) {
      return { status: 400, body: failure('bad-request', 'modelInvocable or userInvocable is required') }
    }
    const target = await assertManageableTarget(body.path)
    if (target.ok !== true) return { status: target.status, body: failure(target.code, target.message) }

    const filePath = target.kind === 'directory' ? join(target.target, 'SKILL.md') : target.target
    let original
    try {
      original = await readFile(filePath, 'utf8')
    } catch (error) {
      return { status: 404, body: failure('not-found', `the skill file cannot be read: ${errorMessage(error)}`) }
    }
    const edit = applyInvocationEdit(original, {
      modelInvocable: body.modelInvocable,
      userInvocable: body.userInvocable,
    })
    if (edit.ok !== true) return { status: 422, body: failure(edit.code, edit.message) }

    let finalText = edit.text
    if (edit.changed) {
      try {
        await writeTextAtomic(filePath, edit.text)
        finalText = await readFile(filePath, 'utf8')
      } catch (error) {
        return { status: 500, body: failure('write-failed', `the skill file could not be written: ${errorMessage(error)}`) }
      }
      if (finalText !== edit.text) {
        try {
          await writeTextAtomic(filePath, original)
        } catch {
          // A restore failure is reported by the error below either way.
        }
        return { status: 500, body: failure('write-failed', 'the skill file did not read back as written') }
      }
    }
    const parsed = parseSkillFrontmatter(finalText)
    if (parsed.ok !== true) {
      if (edit.changed) {
        try {
          await writeTextAtomic(filePath, original)
        } catch {
          // The refusal below is the authoritative answer.
        }
      }
      return { status: 422, body: failure(parsed.code, parsed.message) }
    }

    const now = Date.now()
    if (edit.changed) {
      runtime.recentEdits.set(normalizePathKey(filePath), {
        modelInvocable: parsed.modelInvocable,
        userInvocable: parsed.userInvocable,
        at: now,
      })
    }
    const previous = findCachedSkill(filePath)
    const usageState = await usageStore.load()
    const directory = skillDirectoryOf(filePath)
    const installedState = await installedStore.load()
    const skill = {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      source: previous?.source ?? sourceOfRoot(target.root),
      provider: previous?.provider ?? 'filesystem',
      path: filePath,
      dir: directory,
      agents: previous?.agents ?? (stateCache.data?.agents ?? [DEFAULT_AGENT]).map((agent) => agent.id),
      runtimes: previous?.runtimes ?? (await detectRuntimes([{ name: parsed.name, dir: directory }], false))
        .bySkill.get(parsed.name) ?? ['dsh'],
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
      writable: true,
      // The echo must keep the full state shape, or a client that replaces the
      // row with it would silently lose the provenance flag.
      installed: await provenanceOf({ name: parsed.name, dir: directory }, installedState),
      usage: summarizeSkillUsage(isRecord(usageState?.skills) ? usageState.skills[parsed.name] : undefined, now),
    }
    // Patch the cached state in place and recompute diagnosis atomically so
    // both this response and the next GET /state agree with the file.
    let diagnosis
    if (stateCache.data !== null) {
      stateVersion += 1
      stateCache.inFlight = null
      const cached = findCachedSkill(filePath)
      if (cached !== undefined) {
        cached.modelInvocable = skill.modelInvocable
        cached.userInvocable = skill.userInvocable
        cached.description = skill.description
        cached.installed = skill.installed
        cached.usage = skill.usage
      }
      stateCache.data.diagnosis = diagnoseSkills(stateCache.data.skills, usageState, {
        now,
        since: usageState.since,
        presence: runtime.statePresence,
      })
      stateCache.builtAt = now
      stateCache.dirty = false
      diagnosis = stateCache.data.diagnosis
    }
    return { status: 200, body: { ok: true, skill, ...(diagnosis === undefined ? {} : { diagnosis }) } }
  }

  /** `remove`: delete a whole skill directory or one flat Markdown file. */
  const removeSkill = async (body) => {
    const target = await assertManageableTarget(body.path)
    if (target.ok !== true) return { status: target.status, body: failure(target.code, target.message) }
    if (normalizePathKey(target.target) === normalizePathKey(target.root)) {
      return { status: 403, body: failure('read-only', 'refusing to delete a skill root') }
    }
    const skillFile = target.kind === 'directory' ? join(target.target, 'SKILL.md') : target.target
    const parsed = parseSkillFrontmatter(await readFile(skillFile, 'utf8').catch(() => ''))
    if (typeof body.name === 'string' && body.name.length > 0 && parsed.ok === true && parsed.name !== body.name) {
      return { status: 409, body: failure('name-mismatch', `this file declares the skill "${parsed.name}"`) }
    }
    try {
      await rm(target.target, { recursive: true, force: false })
    } catch (error) {
      return { status: 500, body: failure('delete-failed', `the skill could not be deleted: ${errorMessage(error)}`) }
    }
    const name = parsed.ok === true ? parsed.name : typeof body.name === 'string' ? body.name : undefined
    if (name !== undefined) {
      try {
        const installed = await installedStore.load()
        if (isRecord(installed.skills) && Object.hasOwn(installed.skills, name)) {
          delete installed.skills[name]
          installedStore.schedule()
          await installedStore.flush()
        }
      } catch (error) {
        log.warn(`skill-dashboard: provenance cleanup failed: ${errorMessage(error)}`)
      }
    }
    invalidateState()
    return { status: 200, body: { ok: true, removed: [target.target] } }
  }

  /**
   * `keep`: record the one decision the Host cannot derive from call history.
   *
   * The decision is flushed before the reply so a reload cannot lose it; a
   * later call voids it without a writer (CONTRACT §8.1).
   */
  const keepSkill = async (body) => {
    if (typeof body.name !== 'string' || body.name.length === 0) {
      return { status: 400, body: failure('bad-request', 'name is required') }
    }
    if (typeof body.keep !== 'boolean') {
      return { status: 400, body: failure('bad-request', 'keep must be a boolean') }
    }
    const state = await getState({ force: false })
    if (!state.skills.some((skill) => skill.name === body.name)) {
      return { status: 404, body: failure('not-found', `no skill named "${body.name}"`) }
    }
    const usageState = await usageStore.load()
    if (!isRecord(usageState.skills)) usageState.skills = {}
    let record = isRecord(usageState.skills[body.name]) ? usageState.skills[body.name] : undefined
    let keptAt = null
    let changed = false
    if (body.keep) {
      if (record === undefined) {
        record = emptyUsageRecord()
        usageState.skills[body.name] = record
      }
      record.keptAt = Date.now()
      keptAt = record.keptAt
      changed = true
    } else if (record !== undefined && Object.hasOwn(record, 'keptAt')) {
      delete record.keptAt
      changed = true
    }
    if (changed) usageStore.schedule()
    await usageStore.flush()
    invalidateState()
    return { status: 200, body: { ok: true, name: body.name, keptAt } }
  }

  /**
   * `cleanup`: run the existing mutation handlers once per unique target.
   *
   * A read-only row is a normal outcome, not a failure of the batch, so the
   * request always answers 200 once its shape is valid.
   */
  const cleanupSkills = async (body) => {
    if (body.mode !== 'disable' && body.mode !== 'remove') {
      return { status: 400, body: failure('bad-request', 'mode must be "disable" or "remove"') }
    }
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > 100) {
      return { status: 400, body: failure('bad-request', 'targets must hold between 1 and 100 skills') }
    }
    const seen = new Set()
    const targets = []
    for (const target of body.targets) {
      if (!isRecord(target) || typeof target.name !== 'string' || target.name.length === 0) {
        return { status: 400, body: failure('bad-request', 'every target needs a non-empty name') }
      }
      if (typeof target.path !== 'string' || target.path.length === 0 || !isAbsolute(target.path)) {
        return { status: 400, body: failure('bad-request', 'every target needs an absolute path') }
      }
      const key = normalizePathKey(target.path)
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      targets.push({ name: target.name, path: target.path })
    }
    const results = []
    let succeeded = 0
    let failed = 0
    let allCached = body.mode === 'disable' && stateCache.data !== null
    for (const target of targets) {
      if (allCached && findCachedSkill(target.path) === undefined) allCached = false
      let outcome
      try {
        outcome = body.mode === 'disable'
          ? await setInvocation({ path: target.path, modelInvocable: false, userInvocable: false })
          : await removeSkill({ name: target.name, path: target.path })
      } catch (error) {
        outcome = { status: 500, body: failure('internal-error', errorMessage(error)) }
      }
      if (outcome.status === 200) {
        succeeded += 1
        results.push({ name: target.name, ok: true })
      } else {
        failed += 1
        results.push({
          name: target.name,
          ok: false,
          code: outcome.body?.code ?? 'internal-error',
          message: outcome.body?.message ?? 'the skill could not be changed',
        })
      }
    }
    let diagnosis
    if (body.mode === 'disable' && allCached && stateCache.data !== null) {
      diagnosis = stateCache.data.diagnosis
    } else {
      invalidateState()
      const nextState = await getState({ force: true })
      diagnosis = nextState.diagnosis
    }
    return { status: 200, body: { ok: true, mode: body.mode, succeeded, failed, results, diagnosis } }
  }

  /** Write one fetched file set into a fresh directory, refusing escapes. */
  const writeSkillFiles = async (directory, files) => {
    await mkdir(directory, { recursive: true })
    for (const file of files) {
      const relativePath = sanitizeSkillRelativePath(file.path)
      if (relativePath === null) continue
      const destination = join(directory, relativePath)
      if (!isInsidePath(directory, destination)) continue
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, file.text, 'utf8')
    }
  }

  /** Derive the installed skill name from a fetched file set. */
  const nameFromFiles = (files, fallback) => {
    const entry = files.find((file) => file.path.toLowerCase() === 'skill.md')
    if (entry !== undefined) {
      const parsed = parseSkillFrontmatter(entry.text)
      // The registry only serves kebab-case names, so an unusable frontmatter
      // name falls back to the caller's hint rather than failing the install.
      if (parsed.ok === true && SKILL_NAME.test(parsed.name)) return parsed.name
    }
    return fallback
  }

  /** Staging lives outside every watched skill root so no watcher can hold it. */
  const stagingRoot = () => join(dshHome, 'skill-dashboard', 'staging')

  /** Remove one tree, retrying the transient lock codes a watcher can cause. */
  const removeTreeWithRetry = async (path) => {
    let lastError
    for (let index = 0; index <= MOVE_RETRY_DELAYS.length; index += 1) {
      try {
        await rm(path, { recursive: true, force: true })
        return true
      } catch (error) {
        lastError = error
        if (!MOVE_RETRY_CODES.has(error?.code) || index === MOVE_RETRY_DELAYS.length) break
        await sleep(MOVE_RETRY_DELAYS[index])
      }
    }
    log.warn(`skill-dashboard: could not remove ${path}: ${errorMessage(lastError)}`)
    return false
  }

  /** Discard a staging or backup tree; never throws and never blocks a reply. */
  const discardTree = async (path) => {
    if (typeof path !== 'string' || path.length === 0) return
    await removeTreeWithRetry(path)
  }

  /**
   * Write one fetched file set plus its provenance into a fresh staging tree
   * outside the watched skill roots, ready to be moved into place.
   * @param {{ path: string, text: string }[]} files - fetched file set.
   * @param {object} provenance - record written as `.skill-source.json`.
   * @returns {Promise<string>} absolute staging directory.
   */
  const stageSkillTree = async (files, provenance) => {
    const parent = stagingRoot()
    await mkdir(parent, { recursive: true })
    const staging = join(parent, randomToken())
    try {
      await writeSkillFiles(staging, files)
      await writeJsonAtomic(join(staging, PROVENANCE_FILE), provenance)
    } catch (error) {
      await discardTree(staging)
      throw error
    }
    return staging
  }

  /** Copy one existing skill tree into the staging area before it is replaced. */
  const backupSkillTree = async (directory) => {
    const parent = stagingRoot()
    await mkdir(parent, { recursive: true })
    const backup = join(parent, `backup-${randomToken()}`)
    const copied = await copyTree(directory, backup, resolveTreeIo())
    if (copied.ok !== true) {
      await discardTree(backup)
      throw copied.error ?? new Error('the existing skill tree could not be copied aside')
    }
    return backup
  }

  /** Put a copied skill tree back after a failed swap. */
  const restoreSkillTree = async (backup, directory, name) => {
    if (backup === undefined) return
    await removeTreeWithRetry(directory)
    const restored = await copyTree(backup, directory, resolveTreeIo())
    if (restored.ok !== true) {
      log.warn(`skill-dashboard: could not restore "${name}" after a failed update: ${errorMessage(restored.error)}`)
    }
  }

  /**
   * Resolve one request body's reference into a locator plus its adapter.
   * `body.source` is optional, and a value that disagrees with the reference is
   * a client mistake rather than a second opinion.
   */
  const resolveReference = (body) => {
    const parsed = parseRef(body.ref)
    if (parsed.ok !== true) return { ok: false, status: 400, body: failure(parsed.code, parsed.message) }
    const locator = parsed.value
    if (body.source !== undefined && body.source !== locator.source) {
      return {
        ok: false,
        status: 400,
        body: failure('bad-request', `source "${String(body.source)}" does not serve "${locator.ref}"`),
      }
    }
    const source = SOURCES_LOOKUP(locator.source)
    if (source === undefined) {
      return { ok: false, status: 400, body: failure('unknown-source', `unknown source "${locator.source}"`) }
    }
    return { ok: true, locator, source }
  }

  /** Status for one adapter failure: a reference the caller must sharpen is 409, an outage is 502. */
  const adapterStatus = (code) => (code === 'subpath-required' ? 409 : code === 'bad-request' ? 400 : 502)

  /** `install`: pull one skill into the user agents skill root. */
  const installSkill = async (body, signal) => {
    const resolved = resolveReference(body)
    if (resolved.ok !== true) return resolved
    const { locator, source } = resolved
    const hintedName = typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined
    const fetched = await source.fetch(locator, signal, { name: hintedName })
    if (fetched.ok !== true) return { status: adapterStatus(fetched.code), body: failure(fetched.code, fetched.message) }
    const files = fetched.files
    if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
      return { status: 422, body: failure('invalid-skill', 'this source did not provide a SKILL.md') }
    }
    const declaredName = nameFromFiles(files, undefined)
    // A hinted name that contradicts the SKILL.md would create a folder the
    // catalog cannot name, and every later update by path would refuse it.
    if (hintedName !== undefined && declaredName !== undefined && declaredName !== hintedName) {
      return {
        status: 422,
        body: failure('invalid-skill', `the source declares the skill "${declaredName}", not "${hintedName}"`),
      }
    }
    const name = hintedName ?? declaredName ?? locator.name
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
      return { status: 422, body: failure('invalid-skill', `"${String(name)}" is not a valid skill name`) }
    }
    const root = installRoot()
    const destination = join(root, name)
    if (await pathExists(destination)) {
      return { status: 409, body: failure('already-installed', `"${name}" is already installed; use update`) }
    }
    const installedAt = Date.now()
    const provenance = {
      source: locator.source,
      ref: locator.ref,
      commit: fetched.commit ?? null,
      name,
      version: fetched.version ?? null,
      installedAt,
    }
    let staging
    try {
      staging = await stageSkillTree(files, provenance)
      await mkdir(root, { recursive: true })
      const moved = await moveStagedTree(staging, destination)
      if (moved.ok !== true) {
        return { status: 500, body: failure('write-failed', `the skill could not be written: ${moved.message}`) }
      }
    } catch (error) {
      return { status: 500, body: failure('write-failed', `the skill could not be written: ${errorMessage(error)}`) }
    } finally {
      // The staging tree is always disposable: moved, copied, or abandoned.
      if (staging !== undefined) await discardTree(staging)
    }
    await recordProvenance({ ...provenance, path: destination })
    invalidateState()
    log.info(`skill-dashboard: installed "${name}" from ${locator.source}`)
    return { status: 200, body: { ok: true, name, path: destination } }
  }

  /** `update`: re-fetch one installed skill and report whether anything changed. */
  const updateSkill = async (body, signal) => {
    const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined
    if (name === undefined) return { status: 400, body: failure('bad-request', 'name is required') }
    if (!SKILL_NAME.test(name)) return { status: 400, body: failure('bad-request', `"${name}" is not a valid skill name`) }
    const installed = await installedStore.load()
    const record = isRecord(installed.skills) && isRecord(installed.skills[name]) ? installed.skills[name] : undefined

    let directory
    let localName
    if (body.path !== undefined) {
      const guard = await assertManageableTarget(body.path)
      if (guard.ok !== true) return { status: guard.status, body: failure(guard.code, guard.message) }
      if (guard.kind !== 'directory') return { status: 409, body: failure('flat-skill', FLAT_SKILL_MESSAGE) }
      directory = guard.target
      // The clicked row must be the skill the caller names, or an update would
      // write one skill's source over a different folder. A file whose
      // frontmatter no longer parses is still updatable when its own directory
      // records an origin; without one there is nothing that proves identity.
      const local = parseSkillFrontmatter(await readFile(join(directory, 'SKILL.md'), 'utf8').catch(() => ''))
      localName = local.ok === true ? local.name : undefined
      if (localName !== undefined && localName !== name) {
        return { status: 409, body: failure('name-mismatch', `this file declares the skill "${localName}"`) }
      }
    } else {
      directory = typeof record?.path === 'string' && record.path.length > 0 ? record.path : join(installRoot(), name)
      const guard = await assertManageableTarget(join(directory, 'SKILL.md'))
      if (guard.ok !== true) return { status: guard.status, body: failure(guard.code, guard.message) }
      if (guard.kind !== 'directory') return { status: 409, body: failure('flat-skill', FLAT_SKILL_MESSAGE) }
    }

    // A stored record only describes the directory it was written for; a
    // same-named skill in another root must use its own sidecar or be linked.
    const recordMatches = record !== undefined && (typeof record.path !== 'string' || record.path.length === 0
      || normalizePathKey(record.path) === normalizePathKey(directory))
    const stored = recordMatches ? record : await readProvenanceInDirectory(directory)
    // The skills CLI's lock file is a third origin, valid only for this exact directory.
    const lockRecord = lockProvenanceOf({ name, dir: directory }, await readSkillLock(), installRoot())
    if (body.path !== undefined && localName === undefined && describeProvenance(stored) === null && lockRecord === null) {
      return {
        status: 409,
        body: failure('name-mismatch', 'the skill file at this path declares no name and has no recorded origin'),
      }
    }
    const inputRef = typeof body.ref === 'string' && body.ref.length > 0 ? body.ref
      : stored?.ref ?? (body.path === undefined ? (await readProvenanceFile(name))?.ref : undefined) ?? lockRecord?.ref
    if (typeof inputRef !== 'string' || inputRef.length === 0) {
      return { status: 400, body: failure('unknown-ref', 'no source record exists for this skill; pass a reference') }
    }
    const parsed = parseRef(inputRef)
    if (parsed.ok !== true) return { status: 400, body: failure(parsed.code, parsed.message) }
    const locator = parsed.value
    if (body.source !== undefined && body.source !== locator.source) {
      return { status: 400, body: failure('bad-request', `source "${String(body.source)}" does not serve "${locator.ref}"`) }
    }
    const source = SOURCES_LOOKUP(locator.source)
    if (source === undefined) return { status: 400, body: failure('unknown-source', `unknown source "${locator.source}"`) }

    // An update must read the source now, not a payload cached ten minutes ago.
    const fetched = await source.fetch(locator, signal, { name, refresh: true })
    if (fetched.ok !== true) return { status: adapterStatus(fetched.code), body: failure(fetched.code, fetched.message) }
    const files = fetched.files
    if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
      return { status: 422, body: failure('invalid-skill', 'this source did not provide a SKILL.md') }
    }
    // Only a body-supplied reference can point at another skill: a plain update
    // re-reads the recorded origin, whose name may legitimately differ from the
    // name a discover card installed it under. A link or a re-point must match.
    const originEstablished = typeof stored?.ref === 'string' && stored.ref.length > 0
    const repointing = typeof body.ref === 'string' && body.ref.length > 0 && body.ref !== stored?.ref
    const remoteName = nameFromFiles(files, undefined)
    if ((!originEstablished || repointing) && remoteName !== undefined && remoteName !== name) {
      return {
        status: 409,
        body: failure('name-mismatch', `this skill is "${name}" but the source declares "${remoteName}"`),
      }
    }
    const changedPaths = await changedSkillPaths(directory, files)
    const changed = changedPaths.length > 0
    const installedAt = Date.now()
    const provenance = {
      source: locator.source,
      ref: locator.ref,
      commit: fetched.commit ?? null,
      name,
      version: fetched.version ?? stored?.version ?? null,
      installedAt,
    }
    if (!changed) {
      // Nothing to swap: refresh the portable provenance in place and report it.
      try {
        await writeJsonAtomic(join(directory, PROVENANCE_FILE), provenance)
      } catch (error) {
        return { status: 500, body: failure('write-failed', `the skill could not be updated: ${errorMessage(error)}`) }
      }
      await recordProvenance({ ...provenance, path: directory })
      await recordUpdateChecked(name, { available: false, changedPaths: [], checkedAt: Date.now() })
      invalidateState()
      return { status: 200, body: { ok: true, name, path: directory, changed: false } }
    }
    // A changed skill is replaced wholesale: staging holds the new tree, the old
    // tree is copied aside, and any failure puts the previous tree back.
    let staging
    let backup
    try {
      staging = await stageSkillTree(files, provenance)
      backup = await backupSkillTree(directory)
      if (!(await removeTreeWithRetry(directory))) {
        throw new Error('the existing skill directory is locked and could not be replaced')
      }
      const moved = await moveStagedTree(staging, directory)
      if (moved.ok !== true) {
        await restoreSkillTree(backup, directory, name)
        return { status: 500, body: failure('write-failed', `the skill could not be updated: ${moved.message}`) }
      }
    } catch (error) {
      await restoreSkillTree(backup, directory, name)
      return { status: 500, body: failure('write-failed', `the skill could not be updated: ${errorMessage(error)}`) }
    } finally {
      if (staging !== undefined) await discardTree(staging)
      if (backup !== undefined) await discardTree(backup)
    }
    await recordProvenance({ ...provenance, path: directory })
    await recordUpdateChecked(name, { available: false, changedPaths: [], checkedAt: Date.now() })
    invalidateState()
    log.info(`skill-dashboard: updated "${name}" from ${locator.source}`)
    return { status: 200, body: { ok: true, name, path: directory, changed } }
  }

  /**
   * One skill's upstream read for `check-updates`, bounded and never writing.
   *
   * `refresh` is true only for a manual check: the source adapters share their
   * tree and payload caches across the skills of one repository, so bypassing
   * them per skill would refetch a whole repository tree once per skill.
   */
  const checkOneSkill = async (skill, signal, refresh) => {
    const parsed = parseRef(skill.installed?.ref)
    if (parsed.ok !== true) return { error: parsed.code }
    const source = SOURCES_LOOKUP(parsed.value.source)
    if (source === undefined) return { error: 'unknown-source' }
    const timeout = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS)
    const bounded = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
    let fetched
    try {
      fetched = await source.fetch(parsed.value, bounded, { name: skill.name, refresh })
    } catch {
      return { error: timeout.aborted ? 'timeout' : 'source-unavailable' }
    }
    if (fetched.ok !== true) return { error: fetched.code ?? 'source-unavailable' }
    if (!fetched.files.some((file) => file.path.toLowerCase() === 'skill.md')) return { error: 'invalid-skill' }
    const changedPaths = await changedSkillPaths(skill.dir, fetched.files)
    return { available: changedPaths.length > 0, changedPaths }
  }

  /** `check-updates`: compare one bounded slice of tracked skills against their sources. */
  const checkUpdates = async (body, signal) => {
    const state = await getState({ force: false })
    const tracked = (Array.isArray(state.skills) ? state.skills : [])
      .filter((skill) => isRecord(skill.installed) && typeof skill.dir === 'string' && skill.dir.length > 0)
      .sort((left, right) => compareNames(left.name, right.name))
    const total = tracked.length
    const requestedCursor = Number.isFinite(body.cursor) ? Math.trunc(body.cursor) : 0
    const requestedLimit = Number.isFinite(body.limit) ? Math.trunc(body.limit) : UPDATE_CHECK_LIMIT
    const limit = Math.min(UPDATE_CHECK_LIMIT_MAX, Math.max(1, requestedLimit))
    const cursor = Math.min(Math.max(0, requestedCursor), total)
    const refresh = body.refresh === true
    const now = Date.now()
    const updatesState = await updatesStore.load()
    const records = isRecord(updatesState.skills) ? updatesState.skills : {}
    const slice = tracked.slice(cursor, cursor + limit)
    // Refresh each repository's tree once per chunk: the per-skill reads then
    // share one listing, and their payload keys carry that tree's revision.
    const prepared = slice.map((skill) => {
      const cached = isRecord(records[skill.name]) ? records[skill.name] : undefined
      const cacheTtl = typeof cached?.error === 'string' ? UPDATE_CHECK_ERROR_TTL_MS : UPDATE_CHECK_TTL_MS
      const fresh = !refresh && cached !== undefined && Number.isFinite(cached.checkedAt) && now - cached.checkedAt < cacheTtl
      return { skill, cached, fresh }
    })
    // Refresh each repository's tree once per chunk for the skills that need a
    // read: the per-skill payloads then carry that tree's revision, so a moved
    // branch is never compared against old bytes. Cached verdicts cost nothing.
    const warmed = new Set()
    await Promise.all(prepared.filter((entry) => entry.fresh === false).map(async ({ skill }) => {
      const parsed = parseRef(skill.installed?.ref)
      if (parsed.ok !== true) return
      const source = SOURCES_LOOKUP(parsed.value.source)
      if (typeof source?.warm !== 'function') return
      const key = `${parsed.value.owner}/${parsed.value.repo}`
      if (warmed.has(key)) return
      warmed.add(key)
      // Warm budget stays below the per-skill budget, so a slow tree cannot
      // push the whole chunk past the client's ten-second request bound.
      const timeout = AbortSignal.timeout(4_000)
      const bounded = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
      try {
        await source.warm(parsed.value, bounded)
      } catch {
        // The per-skill read below records the real failure.
      }
    }))
    const checked = await Promise.all(prepared.map(async ({ skill, cached, fresh }) => {
      if (fresh) {
        return {
          name: skill.name,
          available: cached.available === true,
          changedPaths: Array.isArray(cached.changedPaths) ? cached.changedPaths : [],
          ...(typeof cached.error === 'string' ? { error: cached.error } : {}),
          cached: true,
        }
      }
      return { name: skill.name, ...(await checkOneSkill(skill, signal, refresh)) }
    }))
    for (const entry of checked) {
      if (entry.cached === true) continue
      records[entry.name] = entry.error === undefined
        ? { available: entry.available === true, changedPaths: entry.changedPaths, checkedAt: now }
        : { error: entry.error, checkedAt: now }
    }
    updatesState.skills = records
    updatesStore.schedule()
    await updatesStore.flush()
    invalidateState()
    const nextCursor = Math.min(cursor + limit, total)
    return {
      status: 200,
      body: {
        ok: true,
        total,
        cursor,
        nextCursor,
        done: nextCursor >= total,
        checked: checked.map((entry) => ({
          name: entry.name,
          available: entry.available === true,
          changedPaths: Array.isArray(entry.changedPaths) ? entry.changedPaths : [],
          ...(entry.error === undefined ? {} : { error: entry.error }),
        })),
        checkedAt: now,
      },
    }
  }

  /** `refresh`: drop the merged-state cache and answer with a fresh timestamp. */
  const refreshState = async () => {
    invalidateState()
    const state = await getState({ force: true })
    return { status: 200, body: { ok: true, generatedAt: state.generatedAt } }
  }

  /** Persist one provenance record in `installed.json` (`<skill-name>` → record). */
  const recordProvenance = async (record) => {
    try {
      const state = await installedStore.load()
      if (!isRecord(state.skills)) state.skills = {}
      state.skills[record.name] = record
      installedStore.schedule()
    } catch (error) {
      log.warn(`skill-dashboard: provenance recording failed: ${errorMessage(error)}`)
    }
  }

  /** Remember one update-check verdict; a manual update clears an older "available" record. */
  const recordUpdateChecked = async (name, result) => {
    const state = await updatesStore.load()
    if (!isRecord(state.skills)) state.skills = {}
    state.skills[name] = result
    updatesStore.schedule()
    await updatesStore.flush()
  }

  /** Read `.skill-source.json` from the known roots as a fallback provenance. */
  const readProvenanceFile = async (name) => {
    for (const root of [installRoot(), ...knownSkillRoots().map((entry) => entry.path)]) {
      const record = await readProvenanceInDirectory(join(root, name))
      if (describeProvenance(record) !== null) return record
    }
    return undefined
  }

  /** Look up one source adapter by id. */
  const SOURCES_LOOKUP = (id) => (typeof id === 'string' && Object.hasOwn(sources, id) ? sources[id] : undefined)

  /** Names recorded in `installed.json` unioned with live catalog skills. */
  const installedNames = async () => {
    const installedState = await installedStore.load()
    const names = new Set(isRecord(installedState.skills) ? Object.keys(installedState.skills) : [])
    let skills = stateCache.data?.skills
    if (skills === undefined) {
      try {
        const snapshot = await getState({ force: false })
        skills = snapshot.skills
      } catch {
        skills = []
      }
    }
    for (const skill of skills) {
      if (isRecord(skill) && typeof skill.name === 'string' && skill.name.length > 0) {
        names.add(skill.name)
      }
    }
    return names
  }

  /** `discover`: proxy one registry search through this Host. */
  const discover = async (body, signal) => {
    const source = SOURCES_LOOKUP(body.source)
    if (source === undefined) {
      return { status: 400, body: failure('unknown-source', `unknown source "${String(body.source)}"`) }
    }
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    const requestedLimit = Number.isFinite(body.limit) ? Math.trunc(body.limit) : 20
    const limit = Math.min(50, Math.max(1, requestedLimit))
    const outcome = await source.search(query, signal)
    if (outcome.ok !== true) return { status: 502, body: failure(outcome.code, outcome.message) }
    const installed = await installedNames()
    const items = (Array.isArray(outcome.items) ? outcome.items : []).slice(0, limit).map((item) => ({
      ...item,
      // The identifier install writes and update later receives; the panel
      // compares this one, so a card cannot disagree with the mutation.
      installedName: item.name,
      installed: installed.has(item.name),
      ...describeInstallability(item),
    }))
    const note = query.length === 0 && source.id === 'skills-sh' ? 'suggestions' : null
    return { status: 200, body: { ok: true, source: source.id, items, ...(note === null ? {} : { note }) } }
  }

  // ---------------------------------------------------------------- preview

  /** Preview catalog files or an existing bounded registry payload, without staging. */
  const preview = async (body, signal) => {
    const fail = (status, code, message) => ({ status, body: failure(code, message) })
    const requested = body.file === undefined ? undefined : previewRelativePath(body.file)
    if (requested === null) return fail(400, 'bad-request', 'file must be a safe relative path')
    if (body.path !== undefined) {
      if (body.source !== undefined || typeof body.path !== 'string' || !isAbsolute(body.path) || body.path.includes('\0')) {
        return fail(400, 'bad-request', 'path must be an absolute catalog skill path')
      }
      const state = await getState({ force: body.refresh === true })
      // Resolve only the catalog's spelling, never a caller-provided disk path.
      const skill = state.skills.find((entry) => entry.path === body.path)
      if (skill === undefined) return fail(404, 'skill-not-found', 'skill is not in the current catalog')
      let root
      let cacheKey
      try {
        const info = await lstat(skill.path)
        if (!info.isFile() || info.isSymbolicLink()) return fail(403, 'preview-unavailable', 'skill file is not a regular file')
        root = await realpath(dirname(skill.path))
        if (!previewInside(root, await realpath(skill.path))) return fail(403, 'preview-unavailable', 'skill file escapes its directory')
        const directoryInfo = await stat(root)
        cacheKey = JSON.stringify([skill.path, root, info.dev, info.ino, info.mtimeMs, info.size,
          directoryInfo.dev, directoryInfo.ino, directoryInfo.mtimeMs])
      } catch {
        return fail(404, 'preview-unavailable', 'skill file cannot be read')
      }
      const flat = skillDirectoryOf(skill.path) === null
      const defaultPath = basename(skill.path)
      let listing = body.refresh === true ? undefined : localPreviewCache.get(cacheKey)
      if (listing === undefined) {
        listing = flat
          ? { files: [previewMetadata(defaultPath, (await lstat(skill.path)).size)], truncatedFiles: false }
          : await localPreviewFiles(root, join(root, defaultPath))
        localPreviewCache.set(cacheKey, listing)
      }
      const selected = requested ?? defaultPath
      if (!listing.files.some((file) => file.path === selected)) return fail(404, 'file-not-found', 'file is not available in this skill preview')
      const file = await readPreviewFile(root, flat ? skill.path : join(root, ...selected.split('/')), selected)
      Object.assign(listing.files.find((entry) => entry.path === selected), { size: file.size, kind: file.kind })
      return { status: 200, body: { ok: true, skill: {
        name: skill.name, description: skill.description, path: skill.path, source: skill.source,
        version: skill.installed?.version ?? null, readonly: !skill.writable, agents: skill.agents, runtimes: skill.runtimes,
      }, ...(body.fileOnly === true ? {} : listing), file } }
    }
    if (typeof body.source !== 'string' || !Object.hasOwn(sources, body.source)) return fail(400, 'bad-request', 'source must be tencent or skills-sh')
    const parsed = parseRef(body.ref)
    if (parsed.ok !== true) return fail(400, parsed.code, parsed.message)
    const locator = parsed.value
    if (locator.source !== body.source) return fail(400, 'bad-request', `"${locator.ref}" is not a ${body.source} reference`)
    const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined
    if (name !== undefined && (!SKILL_NAME.test(name) || name.length > 128)) {
      return fail(400, 'bad-request', 'name must be a valid skill name')
    }
    // A reference carrying `#path` already names the directory to preview.
    if (name === undefined && locator.path.length === 0) {
      return fail(400, 'bad-request', 'a source ref that names no path needs a skill name')
    }
    const payload = await sources[body.source].preview(locator, signal, {
      name, file: requested, refresh: body.refresh === true,
    })
    if (!payload.ok) return { status: payload.code === 'file-not-found' ? 404 : payload.code === 'bad-request' ? 400 : 502, body: payload }
    return { status: 200, body: { ok: true, skill: {
      name: payload.skill?.name ?? name ?? locator.name,
      description: payload.skill?.description ?? '', source: body.source,
      version: payload.version ?? null, readonly: true,
    }, ...(body.fileOnly === true ? {} : { files: payload.files, truncatedFiles: payload.truncatedFiles }), file: payload.file } }
  }

  // ----------------------------------------------------------------- routes

  /** One JSON reply. Live state is never cached by the browser. */
  const sendJson = (res, status, payload) => {
    if (res.writableEnded) return
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  /** Refuse a method the route does not serve. */
  const sendMethodNotAllowed = (res, allow) => {
    if (res.writableEnded) return
    res.statusCode = 405
    res.setHeader('allow', allow)
    res.end()
  }

  /** The documented trust fence; every route runs it first. */
  function rejected(req, res) {
    let connection
    try {
      connection = ctx.get('connection')
    } catch {
      connection = undefined
    }
    const rejection = connection === undefined ? undefined : connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /** Bound one request body in memory; null means the ceiling was passed. */
  const readBoundedBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.byteLength
      if (size > MAX_BODY_BYTES) {
        req.resume()
        return null
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  }

  /** Read and parse one JSON request body. */
  const readJsonBody = async (req) => {
    const essence = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase()
    if (essence !== 'application/json') {
      return { ok: false, status: 415, code: 'unsupported-media-type', message: 'content-type must be application/json' }
    }
    const text = await readBoundedBody(req)
    if (text === null) return { ok: false, status: 413, code: 'payload-too-large', message: 'request body is too large' }
    if (text.trim().length === 0) return { ok: true, value: {} }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, status: 400, code: 'bad-request', message: 'body must be JSON' }
    }
    if (!isRecord(parsed)) return { ok: false, status: 400, code: 'bad-request', message: 'body must be a JSON object' }
    return { ok: true, value: parsed }
  }

  /** A signal that aborts when the browser goes away, cleaned up by the caller. */
  const requestSignal = (req, res) => {
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('the client disconnected'))
    req.once('aborted', abort)
    res.once('close', abort)
    return {
      signal: controller.signal,
      dispose: () => {
        req.off('aborted', abort)
        res.off('close', abort)
      },
    }
  }

  /** Wrap a route so no handler can ever throw out into the carrier. */
  const guard = (method, run) => (req, res) => {
    try {
      if (rejected(req, res)) return
    } catch (error) {
      sendJson(res, 500, failure('internal-error', errorMessage(error)))
      return
    }
    if (req.method !== method) {
      sendMethodNotAllowed(res, method)
      return
    }
    Promise.resolve()
      .then(() => run(req, res))
      .catch((error) => {
        log.warn(`skill-dashboard: ${req.method} ${req.url ?? ''} failed: ${errorMessage(error)}`)
        sendJson(res, 500, failure('internal-error', errorMessage(error)))
      })
  }

  /** `GET /skill-dashboard/state`. */
  const stateRoute = guard('GET', async (_req, res) => {
    try {
      const state = await getState({ force: false })
      sendJson(res, 200, state)
    } catch (error) {
      log.warn(`skill-dashboard: state read failed: ${errorMessage(error)}`)
      sendJson(res, 500, failure('state-unavailable', errorMessage(error)))
    }
  })

  /** `POST /skill-dashboard/action`. */
  const actionRoute = guard('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (body.ok !== true) {
      sendJson(res, body.status, failure(body.code, body.message))
      return
    }
    const action = typeof body.value.action === 'string' ? body.value.action : ''
    const fenced = requestSignal(req, res)
    let outcome
    try {
      switch (action) {
        case 'set-invocation':
          outcome = await setInvocation(body.value)
          break
        case 'remove':
          outcome = await removeSkill(body.value)
          break
        case 'keep':
          outcome = await keepSkill(body.value)
          break
        case 'cleanup':
          outcome = await cleanupSkills(body.value)
          break
        case 'install':
          outcome = await installSkill(body.value, fenced.signal)
          break
        case 'update':
          outcome = await updateSkill(body.value, fenced.signal)
          break
        case 'check-updates':
          outcome = await checkUpdates(body.value, fenced.signal)
          break
        case 'refresh':
          outcome = await refreshState()
          break
        default:
          outcome = { status: 400, body: failure('unknown-action', `unknown action "${action}"`) }
      }
    } catch (error) {
      log.warn(`skill-dashboard: action "${action}" failed: ${errorMessage(error)}`)
      outcome = { status: 500, body: failure('internal-error', errorMessage(error)) }
    } finally {
      fenced.dispose()
    }
    sendJson(res, outcome.status, outcome.body)
  })

  /** `POST /skill-dashboard/discover`. */
  const discoverRoute = guard('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (body.ok !== true) {
      sendJson(res, body.status, failure(body.code, body.message))
      return
    }
    const fenced = requestSignal(req, res)
    let outcome
    try {
      outcome = await discover(body.value, fenced.signal)
    } catch (error) {
      outcome = { status: 502, body: failure('source-unavailable', errorMessage(error)) }
    } finally {
      fenced.dispose()
    }
    sendJson(res, outcome.status, outcome.body)
  })

  /** `POST /skill-dashboard/preview`, with the same trust and JSON fences. */
  const previewRoute = guard('POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendJson(res, body.status, failure(body.code, body.message))
      return
    }
    const fenced = requestSignal(req, res)
    try {
      const outcome = await preview(body.value, fenced.signal)
      sendJson(res, outcome.status, outcome.body)
    } finally {
      fenced.dispose()
    }
  })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: PREVIEW_PATH, handler: previewRoute }),
    `skill-dashboard: POST ${PREVIEW_PATH}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: stateRoute,
      }),
    `skill-dashboard: GET ${STATE_PATH}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ACTION_PATH,
        handler: actionRoute,
      }),
    `skill-dashboard: POST ${ACTION_PATH}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DISCOVER_PATH,
        handler: discoverRoute,
      }),
    `skill-dashboard: POST ${DISCOVER_PATH}`,
  )

  // --------------------------------------------------------------- listeners

  // Model loads. Denials also emit `tools/result`, so the isError filter is the
  // difference between "the model used this skill" and "the model was refused".
  ctx.on('tools/result', (exec, result) => {
    try {
      if (exec?.name !== 'skill') return
      if (result?.isError === true) return
      const name = exec.arguments?.name
      if (typeof name !== 'string' || name.length === 0) return
      const agentId = agentIdOf(exec)
      const sessionId = typeof exec.agent?.id === 'string' ? exec.agent.id : undefined
      recordUsage(name, agentId, sessionId, 'model')
    } catch (error) {
      log.warn(`skill-dashboard: tool usage listener failed: ${errorMessage(error)}`)
    }
  })

  // Explicit `/name` gestures carry their own message source.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'user/message') return
      const source = event.data?.source
      if (source?.kind !== 'skill-invocation') return
      const name = source.name
      if (typeof name !== 'string' || name.length === 0) return
      const sessionId = typeof session?.id === 'string' ? session.id : undefined
      let agentId
      const presets = ctx.get('agentPresets')
      if (presets !== undefined && typeof presets.presetForSession === 'function' && session !== undefined) {
        try {
          const preset = presets.presetForSession(session)
          if (typeof preset === 'string' && preset.length > 0) agentId = preset
        } catch {
          // An unreadable projection falls back to `'default'` below.
        }
      }
      recordUsage(name, agentId ?? 'default', sessionId, 'user')
    } catch (error) {
      log.warn(`skill-dashboard: session usage listener failed: ${errorMessage(error)}`)
    }
  })

  // A provider-side catalog change marks the cache dirty and debounces the refresh.
  ctx.on('skills/change', () => {
    try {
      scheduleStateInvalidation()
    } catch {
      // Cache invalidation is best effort.
    }
  })

  // Flush both stores and clear timers on teardown so reloads and tests exit cleanly.
  ctx.effect(
    () => () => {
      runtime.disposed = true
      if (stateCache.warmupTimer !== null) {
        clearTimeout(stateCache.warmupTimer)
        stateCache.warmupTimer = null
      }
      if (stateCache.invalidateTimer !== null) {
        clearTimeout(stateCache.invalidateTimer)
        stateCache.invalidateTimer = null
      }
      void usageStore.flush()
      void installedStore.flush()
    },
    'skill-dashboard: store flusher',
  )

  // Warm both stores and the initial state snapshot so the first UI paint is instant.
  void usageStore.load().catch(() => {})
  void installedStore.load().catch(() => {})
  stateCache.warmupTimer = setTimeout(() => {
    stateCache.warmupTimer = null
    if (runtime.disposed) return
    void getState({ force: false }).catch(() => {})
  }, 0)
  stateCache.warmupTimer.unref?.()
}

/**
 * Existence probe used by the install/update guards.
 * @param {string} path - absolute path.
 * @returns {Promise<boolean>} whether something exists there.
 */
async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
