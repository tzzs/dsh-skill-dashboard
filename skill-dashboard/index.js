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
const STATE_CACHE_MS = 1_500
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
    tree: (owner, repo, branch) => `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    raw: (owner, repo, branch, path) => `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
    page: (id) => `https://skills.sh/${id}`,
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

/** One empty usage store. */
function emptyUsageStore() {
  return { version: 1, skills: {}, recent: [] }
}

/** One empty provenance store. */
function emptyInstalledStore() {
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

    async fetch(ref, signal) {
      const slug = typeof ref === 'string' ? ref.trim() : ''
      if (slug.length === 0) return failure('bad-request', 'a tencent ref (skill slug) is required')
      const cached = payloadCache.get(`tencent:${slug}`)
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

  /** Load (and cache) the blob paths of one GitHub repository. */
  const loadRepoTrees = async (owner, repo, signal, refresh = false) => {
    const key = `${owner}/${repo}`
    const cached = refresh ? undefined : treeCache.get(key)
    if (cached !== undefined) return { ok: true, ...cached }
    let lastFailure
    for (const branch of ['main', 'master']) {
      const outcome = await httpJson(ENDPOINTS['skills-sh'].tree(owner, repo, branch), {
        signal,
        headers: { accept: 'application/vnd.github+json' },
      })
      if (outcome.ok === true) {
        const tree = pickArray(outcome.value, [['tree'], ['data', 'tree']])
        if (tree === undefined) return failure('source-unavailable', 'GitHub returned an unexpected tree payload')
        const paths = tree
          .filter((entry) => isRecord(entry) && entry.type === 'blob' && typeof entry.path === 'string')
          .map((entry) => entry.path)
        const sizes = Object.fromEntries(tree.filter((entry) => isRecord(entry) && typeof entry.path === 'string' && Number.isFinite(entry.size)).map((entry) => [entry.path, entry.size]))
        const value = { branch, paths, sizes, truncated: outcome.value?.truncated === true }
        treeCache.set(key, value)
        return { ok: true, ...value }
      }
      lastFailure = outcome
      if (outcome.status !== 404) break
    }
    return lastFailure ?? failure('source-unavailable', 'the GitHub tree could not be read')
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

  /** Fetch one skill directory straight from raw.githubusercontent.com. */
  const fetchSkillFromRaw = async (owner, repo, branch, directory, signal) => {
    const prefix = directory.length > 0 ? `${directory}/` : ''
    const skillPath = `${prefix}SKILL.md`
    const raw = await httpText(ENDPOINTS['skills-sh'].raw(owner, repo, branch, skillPath), { signal })
    if (raw.ok !== true) return raw
    return { ok: true, files: [{ path: 'SKILL.md', text: raw.text }], version: null }
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

    async fetch(ref, signal, hints = {}) {
      const trimmed = typeof ref === 'string' ? ref.trim() : ''
      const segments = trimmed.split('/').filter((segment) => segment.length > 0)
      if (segments.length !== 2) return failure('bad-request', 'a skills.sh ref must be "owner/repo"')
      const [owner, repo] = segments
      const name = typeof hints.name === 'string' && hints.name.length > 0 ? hints.name : repo
      const cacheKey = `skills-sh:${owner}/${repo}#${name}`
      const cached = payloadCache.get(cacheKey)
      if (cached !== undefined) return cached

      const tree = await loadRepoTrees(owner, repo, signal)
      if (tree.ok !== true) {
        // GitHub's tree API is rate limited at 60 requests/hour; a direct raw
        // read of the conventional layout still works when the tree is refused.
        if (tree.status === 403 || tree.status === 429) {
          for (const branch of ['main', 'master']) {
            for (const directory of [name, '']) {
              const direct = await fetchSkillFromRaw(owner, repo, branch, directory, signal)
              if (direct.ok === true) {
                payloadCache.set(cacheKey, direct)
                return direct
              }
            }
          }
          return failure(
            'source-rate-limited',
            'GitHub refused the repository tree (rate limit); try again later or pick another result',
          )
        }
        return tree
      }
      const picked = pickSkillDirectory(tree.paths, name)
      if (picked === undefined) return failure('source-unavailable', `"${name}" has no SKILL.md in ${owner}/${repo}`)
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
      const fetched = await mapWithLimit(wanted.slice(0, MAX_INSTALL_FILES), MAX_FILE_FETCH_CONCURRENCY, async (path) => {
        const raw = await httpText(ENDPOINTS['skills-sh'].raw(owner, repo, tree.branch, `${prefix}${path}`), { signal })
        if (raw.ok !== true) return raw
        return { ok: true, value: { path, text: raw.text } }
      })
      if (fetched.ok !== true) return fetched
      const files = boundFileSet(fetched.results)
      if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
        return failure('source-unavailable', 'this skill did not provide a SKILL.md')
      }
      const result = { ok: true, files, version: null, truncatedFiles: tree.truncated || wanted.length > files.length }
      payloadCache.set(cacheKey, result)
      return result
    },
  }

  /** Preview metadata and content have separate short caches; unopened files are never fetched. */
  const previewSource = async (source, ref, signal, hints = {}) => {
    const key = `${source}:${ref}#${hints.name}`
    let listing = hints.refresh ? undefined : previewListingCache.get(key)
    let fallbackFile
    if (listing === undefined) {
      let rows
      let version = null
      let branch
      let prefix = ''
      let upstreamTruncated = false
      if (source === 'tencent') {
        const response = await httpJson(ENDPOINTS.tencent.files(ref), { signal })
        if (!response.ok) return response
        rows = pickArray(response.value, [['data', 'files'], ['files'], ['data']])
        if (rows === undefined) return failure('source-unavailable', '腾讯 SkillHub returned no file list for this skill')
        const envelope = isRecord(response.value?.data) ? response.value.data : response.value
        version = stringField(envelope, ['version', 'latestVersion']) ?? null
        rows = rows.map((row) => ({ path: stringField(row, ['path', 'name', 'filename']), size: numberField(row, ['size', 'bytes']) }))
      } else {
        const [owner, repo] = ref.split('/')
        const tree = await loadRepoTrees(owner, repo, signal, hints.refresh)
        if (!tree.ok) {
          // Keep the conventional-layout fallback lazy, too: probe only SKILL.md.
          if (tree.status !== 403 && tree.status !== 429) return tree
          for (const fallbackBranch of ['main', 'master']) {
            for (const directory of [hints.name, '']) {
              const url = ENDPOINTS['skills-sh'].raw(owner, repo, fallbackBranch, `${directory ? `${directory}/` : ''}SKILL.md`)
              const file = await httpPreviewFile(url, 'SKILL.md', 0, signal)
              if (!file.ok) continue
              listing = { files: [previewMetadata('SKILL.md', file.file.size)], version: null,
                branch: fallbackBranch, prefix: directory ? `${directory}/` : '', truncatedFiles: true }
              fallbackFile = file.file
              break
            }
            if (listing) break
          }
          if (!listing) return failure('source-rate-limited', 'GitHub refused the repository tree; try again later')
        } else {
          const picked = pickSkillDirectory(tree.paths, hints.name)
          if (!picked) return failure('source-unavailable', `"${hints.name}" has no SKILL.md in ${ref}`)
          branch = tree.branch
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
        listing = { files: files.slice(0, MAX_INSTALL_FILES), version, branch, prefix,
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
        const [owner, repo] = ref.split('/')
        const rawPath = `${listing.prefix}${selected}`.split('/').map(encodeURIComponent).join('/')
        const url = source === 'tencent' ? ENDPOINTS.tencent.file(ref, selected)
          : ENDPOINTS['skills-sh'].raw(owner, repo, listing.branch, rawPath)
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
  tencent.preview = (ref, signal, hints) => previewSource('tencent', ref, signal, hints)
  skillsSh.preview = (ref, signal, hints) => previewSource('skills-sh', ref, signal, hints)
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

  /** Mutable per-activation state; nothing here survives a plugin reload. */
  const runtime = {
    disposed: false,
    stateCache: undefined,
    stateCacheAt: 0,
    stateInFlight: undefined,
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
    // The documented install location of this profile, kept as the last resort.
    roots.add('D:\\apps\\DeepSeek Harness')
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
  const resolvedInstallRoots = async () => {
    const roots = []
    for (const root of installRoots()) {
      try {
        roots.push(await realpath(root))
      } catch {
        // A root that cannot be resolved is still compared by name.
        roots.push(root)
      }
    }
    return roots
  }

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
    for (const skill of runtime.stateCache?.skills ?? []) {
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

  /** Whether a real file exists at `path`, and it is not part of the installation. */
  const resolveWritable = async (path) => {
    if (typeof path !== 'string' || path.length === 0) return false
    try {
      const real = await realpath(path)
      const info = await stat(real)
      if (!info.isFile()) return false
      return !isProtectedInstallPath(real, await resolvedInstallRoots())
    } catch {
      return false
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

  /**
   * Provenance for one catalog entry.
   *
   * `installed.json` is the source of truth, but its record is only borrowed
   * when its stored directory is the directory this entry resolved to — a
   * same-named skill in another root must never inherit someone else's record.
   * Fallback: the skill's own `.skill-source.json`, which cannot be ambiguous.
   * Anything unprovable answers `null`.
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
    return describeProvenance(await readProvenanceInDirectory(directory))
  }

  /** Build the CONTRACT §4 state document from the live catalog and the stores. */
  const buildState = async () => {
    const now = Date.now()
    pruneRecentEdits(now)
    const usageState = await usageStore.load()
    const roster = await readAgentRoster()
    const lists = []
    if (roster.length > 0) {
      for (const agent of roster) {
        const catalog = await readScopedCatalog(agent.id)
        if (catalog !== undefined) lists.push({ id: agent.id, skills: catalog })
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
    const installedState = await installedStore.load()
    await Promise.all(
      merged.map(async (skill) => {
        skill.writable = await resolveWritable(skill.path)
        skill.installed = await provenanceOf(skill, installedState)
      }),
    )
    return {
      ok: true,
      generatedAt: now,
      agents,
      skills: merged,
      usage: summarizeUsage(usageState, now),
      sources: Object.values(sources).map((source) => ({
        id: source.id,
        title: source.title,
        status: 'ready',
        note: null,
      })),
    }
  }

  /** Serve the merged state, reusing a short-lived cache unless `force` is set. */
  const getState = async (force = false) => {
    const now = Date.now()
    if (!force && runtime.stateCache !== undefined && now - runtime.stateCacheAt < STATE_CACHE_MS) {
      return runtime.stateCache
    }
    if (runtime.stateInFlight !== undefined) return runtime.stateInFlight
    runtime.stateInFlight = (async () => {
      try {
        const state = await buildState()
        runtime.stateCache = state
        runtime.stateCacheAt = Date.now()
        return state
      } finally {
        runtime.stateInFlight = undefined
      }
    })()
    return runtime.stateInFlight
  }

  /** Forget the cached state; the next read rescans every preset. */
  const invalidateState = () => {
    runtime.stateCache = undefined
    runtime.stateCacheAt = 0
  }

  /** Find one skill entry in the cached state by absolute path. */
  const findCachedSkill = (path) => {
    if (typeof path !== 'string' || runtime.stateCache === undefined) return undefined
    const key = normalizePathKey(path)
    return runtime.stateCache.skills.find((skill) => typeof skill.path === 'string' && normalizePathKey(skill.path) === key)
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
      if (!isInsidePath(candidate, absolute) && !isInsidePath(candidate, real)) continue
      const resolved = await resolvedPath(candidate)
      if (isInsidePath(resolved, absolute) || isInsidePath(resolved, real)) return candidate
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
      agents: previous?.agents ?? (runtime.stateCache?.agents ?? [DEFAULT_AGENT]).map((agent) => agent.id),
      modelInvocable: parsed.modelInvocable,
      userInvocable: parsed.userInvocable,
      writable: true,
      // The echo must keep the full state shape, or a client that replaces the
      // row with it would silently lose the provenance flag.
      installed: await provenanceOf({ name: parsed.name, dir: directory }, installedState),
      usage: summarizeSkillUsage(isRecord(usageState?.skills) ? usageState.skills[parsed.name] : undefined, now),
    }
    // Patch the cached state in place so the next fetch already agrees with the
    // file, even though the provider's watcher needs a moment to catch up.
    if (runtime.stateCache !== undefined) {
      const cached = findCachedSkill(filePath)
      if (cached !== undefined) {
        cached.modelInvocable = skill.modelInvocable
        cached.userInvocable = skill.userInvocable
        cached.description = skill.description
        cached.installed = skill.installed
        cached.usage = skill.usage
      }
      runtime.stateCacheAt = now
    }
    return { status: 200, body: { ok: true, skill } }
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
      void (async () => {
        try {
          const installed = await installedStore.load()
          if (isRecord(installed.skills) && Object.hasOwn(installed.skills, name)) {
            delete installed.skills[name]
            installedStore.schedule()
          }
        } catch (error) {
          log.warn(`skill-dashboard: provenance cleanup failed: ${errorMessage(error)}`)
        }
      })()
    }
    invalidateState()
    return { status: 200, body: { ok: true, removed: [target.target] } }
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

  /** `install`: pull one skill into the user agents skill root. */
  const installSkill = async (body, signal) => {
    const source = SOURCES_LOOKUP(body.source)
    if (source === undefined) {
      return { status: 400, body: failure('unknown-source', `unknown source "${String(body.source)}"`) }
    }
    const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
    if (ref.length === 0) return { status: 400, body: failure('bad-request', 'ref is required') }
    const hintedName = typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined
    const fetched = await source.fetch(ref, signal, { name: hintedName })
    if (fetched.ok !== true) return { status: 502, body: failure(fetched.code, fetched.message) }
    const files = fetched.files
    if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
      return { status: 422, body: failure('invalid-skill', 'this source did not provide a SKILL.md') }
    }
    const fallbackName = ref.split('/').pop()
    const name = hintedName ?? nameFromFiles(files, fallbackName)
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
      return { status: 422, body: failure('invalid-skill', `"${String(name)}" is not a valid skill name`) }
    }
    const root = installRoot()
    const destination = join(root, name)
    if (await pathExists(destination)) {
      return { status: 409, body: failure('already-installed', `"${name}" is already installed; use update`) }
    }
    const installedAt = Date.now()
    const provenance = { source: source.id, ref, name, version: fetched.version ?? null, installedAt }
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
    log.info(`skill-dashboard: installed "${name}" from ${source.id}`)
    return { status: 200, body: { ok: true, name, path: destination } }
  }

  /** `update`: re-fetch one installed skill and report whether anything changed. */
  const updateSkill = async (body, signal) => {
    const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined
    if (name === undefined) return { status: 400, body: failure('bad-request', 'name is required') }
    if (!SKILL_NAME.test(name)) return { status: 400, body: failure('bad-request', `"${name}" is not a valid skill name`) }
    const installed = await installedStore.load()
    const record = isRecord(installed.skills) && isRecord(installed.skills[name]) ? installed.skills[name] : undefined
    const onDisk = record === undefined ? await readProvenanceFile(name) : undefined
    const sourceId = typeof body.source === 'string' && body.source.length > 0 ? body.source : record?.source ?? onDisk?.source
    const ref = typeof body.ref === 'string' && body.ref.length > 0 ? body.ref : record?.ref ?? onDisk?.ref
    if (typeof sourceId !== 'string' || typeof ref !== 'string') {
      return { status: 400, body: failure('unknown-ref', 'no source record exists for this skill; pass source and ref') }
    }
    const source = SOURCES_LOOKUP(sourceId)
    if (source === undefined) return { status: 400, body: failure('unknown-source', `unknown source "${sourceId}"`) }
    const directory = typeof record?.path === 'string' && record.path.length > 0 ? record.path : join(installRoot(), name)
    const guard = await assertManageableTarget(join(directory, 'SKILL.md'))
    if (guard.ok !== true) return { status: guard.status, body: failure(guard.code, guard.message) }
    const fetched = await source.fetch(ref, signal, { name })
    if (fetched.ok !== true) return { status: 502, body: failure(fetched.code, fetched.message) }
    const files = fetched.files
    if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
      return { status: 422, body: failure('invalid-skill', 'this source did not provide a SKILL.md') }
    }
    let changed = false
    for (const file of files) {
      const relativePath = sanitizeSkillRelativePath(file.path)
      if (relativePath === null) continue
      const existing = await readFile(join(directory, relativePath), 'utf8').catch(() => undefined)
      if (existing !== file.text) changed = true
    }
    const installedAt = Date.now()
    const provenance = {
      source: source.id,
      ref,
      name,
      version: fetched.version ?? record?.version ?? null,
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
    invalidateState()
    log.info(`skill-dashboard: updated "${name}" from ${source.id}`)
    return { status: 200, body: { ok: true, name, path: directory, changed } }
  }

  /** `refresh`: drop the merged-state cache and answer with a fresh timestamp. */
  const refreshState = async () => {
    invalidateState()
    const state = await getState(true)
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

  /** Names recorded in `installed.json`, used to mark discovery results. */
  const installedNames = async () => {
    const state = await installedStore.load()
    return new Set(isRecord(state.skills) ? Object.keys(state.skills) : [])
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
      const state = await getState(body.refresh === true)
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
        version: skill.installed?.version ?? null, readonly: !skill.writable, agents: skill.agents,
      }, ...(body.fileOnly === true ? {} : listing), file } }
    }
    if (typeof body.source !== 'string' || !Object.hasOwn(sources, body.source)) return fail(400, 'bad-request', 'source must be tencent or skills-sh')
    if (typeof body.ref !== 'string' || body.ref.length > 256 || /[\x00-\x20\\?#%:]/.test(body.ref) ||
      (body.source === 'tencent' ? !SKILL_NAME.test(body.ref) : !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(body.ref)) ||
      body.ref.split('/').some((part) => part === '.' || part === '..') ||
      typeof body.name !== 'string' || !SKILL_NAME.test(body.name) || body.name.length > 128) {
      return fail(400, 'bad-request', 'a valid source ref and skill name are required')
    }
    const payload = await sources[body.source].preview(body.ref, signal, {
      name: body.name, file: requested, refresh: body.refresh === true,
    })
    if (!payload.ok) return { status: payload.code === 'file-not-found' ? 404 : payload.code === 'bad-request' ? 400 : 502, body: payload }
    return { status: 200, body: { ok: true, skill: {
      name: payload.skill?.name ?? body.name,
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
      const state = await getState(false)
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
        case 'install':
          outcome = await installSkill(body.value, fenced.signal)
          break
        case 'update':
          outcome = await updateSkill(body.value, fenced.signal)
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
          // An unreadable projection falls back to the SessionId below.
        }
      }
      recordUsage(name, agentId ?? sessionId ?? 'default', sessionId, 'user')
    } catch (error) {
      log.warn(`skill-dashboard: session usage listener failed: ${errorMessage(error)}`)
    }
  })

  // A provider-side catalog change makes the cached merge stale.
  ctx.on('skills/change', () => {
    try {
      invalidateState()
    } catch {
      // Cache invalidation is best effort.
    }
  })

  // Flush both stores on teardown so a debounce window never loses a count.
  ctx.effect(
    () => () => {
      runtime.disposed = true
      void usageStore.flush()
      void installedStore.flush()
    },
    'skill-dashboard: store flusher',
  )

  // Warm both stores so the first route call does not pay two disk reads.
  void usageStore.load().catch(() => {})
  void installedStore.load().catch(() => {})
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
