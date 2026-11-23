/**
 * GrepMem for DeepSeek Harness.
 *
 * DSH already keeps an append-only, replay-validated session log, and its
 * compaction backend replaces older history on the model surface without
 * deleting those events. This plugin adds the missing half of GrepMem:
 * index-free regex recall over the raw log.
 *
 * Two tools share one bounded cache:
 * - `grep_history` searches the calling session, including content compaction
 *   removed from context.
 * - `grep_sessions` searches earlier sessions in the same workspace, newest
 *   first, with exact same-`cwd` authorization.
 *
 * No embeddings, index, extra model request, or session event is created. The
 * log stays the source of truth; this plugin only reads it on demand.
 *
 * @module @local/dsh-grepmem
 */

import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import { Worker } from 'node:worker_threads'

import { scanCore } from './scan-core.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'grepmem'

/** Host services this plugin needs. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery', 'agents']

const DEFAULTS = Object.freeze({
  enabled: true,
  maxMatches: 10,
  maxContextLines: 3,
  lineChars: 300,
  resultChars: 6000,
  timeoutMs: 10_000,
  maxSessions: 6,
  cacheSessions: 6,
  cacheChars: 16_000_000,
  persistedCacheTtlMs: 15_000,
  compactionNudge: true,
  fastPath: true,
  fastTimeoutMs: 200,
  includeReasoning: false,
})

const LIMITS = Object.freeze({
  maxMatches: 30,
  maxContextLines: 3,
  lineChars: 2000,
  resultChars: 40_000,
  timeoutMs: 60_000,
  maxSessions: 25,
  cacheSessions: 24,
  cacheChars: 128_000_000,
  persistedCacheTtlMs: 300_000,
  fastTimeoutMs: 5000,
})

const HISTORY_TOOL = 'grep_history'
const SESSIONS_TOOL = 'grep_sessions'

const KIND_LABELS = Object.freeze({
  user: 'user messages',
  assistant: 'your replies',
  tool: 'tool outputs',
  summary: 'summaries',
})

const PROMPT_TEXT = [
  'Your session history is kept in a complete log even after older context is compacted.',
  'Use grep_history to recover exact details from this session - names, numbers, IDs, paths, URLs,',
  'errors, or earlier tool output - before saying a detail is unavailable or redoing work.',
  'Use grep_sessions to search earlier sessions in the same workspace when the detail may predate this one.',
].join('\n')

const NUDGE_TEXT = [
  '[GrepMem] Older context was just compacted. Your full history, including the removed messages and',
  'tool output, is still searchable with grep_history. Grep for exact details before redoing work or',
  'reporting them unavailable.',
].join(' ')

const HISTORY_DESCRIPTION = [
  'Search the complete, uncompressed log of this session with a case-insensitive regular expression.',
  'It covers user messages, assistant replies, and tool output that compaction has removed from context;',
  'earlier grep_history results are excluded. Matches are grouped by turn and tool call, and paged with',
  'offset. Set multiline=true to let the pattern span line boundaries.',
].join(' ')

const SESSIONS_DESCRIPTION = [
  'Search the complete logs of earlier sessions in this workspace (exact same working directory),',
  'newest first. Use it when a detail may predate the current session; child and subagent sessions are',
  'excluded unless include_child_sessions=true. Results are grouped by session title, then by turn and',
  'tool call, and paged with offset. Read-only and index-free.',
].join(' ')

const COMMON_PROPERTIES = {
  pattern: {
    type: 'string',
    description: 'Case-insensitive JavaScript regular expression. Prefer exact strings you saw before: names, numbers, IDs, paths, URLs, error text.',
  },
  max_matches: {
    type: 'integer',
    description: 'Matching lines (or matches in multiline mode) to show. Defaults to 10; the configured cap applies.',
  },
  offset: {
    type: 'integer',
    description: 'Skip this many matches. Use the offset in the result footer to get the next page.',
  },
  context_lines: {
    type: 'integer',
    description: 'Lines of context around each match. Defaults to 1, at most 3.',
  },
  count: {
    type: 'boolean',
    description: 'Return only the number of matching lines or matches. Defaults to false.',
  },
  multiline: {
    type: 'boolean',
    description: 'Let the pattern span line boundaries within one history entry. Each regex match is then one hit.',
  },
}

const HISTORY_PARAMETERS = {
  type: 'object',
  properties: { ...COMMON_PROPERTIES },
  required: ['pattern'],
  additionalProperties: false,
}

const SESSIONS_PARAMETERS = {
  type: 'object',
  properties: {
    ...COMMON_PROPERTIES,
    max_sessions: {
      type: 'integer',
      description: 'Sessions to search, newest first. Defaults to the configured limit.',
    },
    include_child_sessions: {
      type: 'boolean',
      description: 'Also search forked and subagent sessions. Defaults to false.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
}

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** Resolve deployment config with bounds, so a bad row cannot remove every limit. */
function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: config.enabled !== false,
    maxMatches: clampInteger(config.maxMatches, DEFAULTS.maxMatches, 1, LIMITS.maxMatches),
    maxContextLines: clampInteger(config.maxContextLines, DEFAULTS.maxContextLines, 0, LIMITS.maxContextLines),
    lineChars: clampInteger(config.lineChars, DEFAULTS.lineChars, 80, LIMITS.lineChars),
    resultChars: clampInteger(config.resultChars, DEFAULTS.resultChars, 500, LIMITS.resultChars),
    timeoutMs: clampInteger(config.timeoutMs, DEFAULTS.timeoutMs, 1000, LIMITS.timeoutMs),
    maxSessions: clampInteger(config.maxSessions, DEFAULTS.maxSessions, 1, LIMITS.maxSessions),
    cacheSessions: clampInteger(config.cacheSessions, DEFAULTS.cacheSessions, 1, LIMITS.cacheSessions),
    cacheChars: clampInteger(config.cacheChars, DEFAULTS.cacheChars, 1_000_000, LIMITS.cacheChars),
    persistedCacheTtlMs: clampInteger(config.persistedCacheTtlMs, DEFAULTS.persistedCacheTtlMs, 0, LIMITS.persistedCacheTtlMs),
    compactionNudge: config.compactionNudge !== false,
    fastPath: config.fastPath !== false,
    fastTimeoutMs: clampInteger(config.fastTimeoutMs, DEFAULTS.fastTimeoutMs, 50, LIMITS.fastTimeoutMs),
    includeReasoning: config.includeReasoning === true,
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function integerArgument(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  return clampInteger(value, fallback, min, max)
}

function booleanArgument(value) {
  return value === true || value === 'true'
}

/** Render model message content as searchable text without inventing data. */
function contentText(content, includeReasoning) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'reasoning':
        if (includeReasoning && typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push('[image]')
        break
      case 'file':
        parts.push(typeof block.path === 'string' ? `[file ${block.path}]` : '[file]')
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

function splitLines(text) {
  return String(text).split(/\r?\n/)
}

/** Bound a tool-call argument blob for a group header. */
function argsPreview(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  const compact = raw.replace(/\s+/g, ' ').trim()
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact
}

/**
 * Incremental entry builder. State is cached per session so a later call only
 * folds events appended since the previous read; turn/step and pending tool
 * calls survive across batches.
 */
function createEntryState() {
  return { turn: 0, step: 0, pendingCalls: new Map(), entries: [], chars: 0 }
}

function addEntry(state, options, kind, header, text) {
  const lines = splitLines(text)
  let chars = header.length + 1
  for (const line of lines) chars += line.length + 1
  state.entries.push({ kind, header, lines, sessionId: options.sessionId })
  state.chars += chars
}

/**
 * Fold raw session events into GrepMem-style entries: a label plus the lines
 * that produced it. Events hidden from the surface by compaction stay
 * available because the raw log is read; earlier grep output is skipped to
 * avoid echoing recalls.
 */
function appendEntries(state, events, options) {
  for (const event of events) {
    const data = event?.data
    if (data === null || typeof data !== 'object') continue
    switch (event.type) {
      case 'turn/start':
        if (Number.isInteger(data.turn)) state.turn = data.turn
        break
      case 'step/start':
        if (Number.isInteger(data.step)) state.step = data.step
        break
      case 'turn/end':
        state.pendingCalls.clear()
        break
      case 'user/message': {
        // UserMessage is the event data itself; older/synthetic shapes may nest it under `message`.
        const message = data.message ?? data
        const kind = message?.source?.kind === 'compact-checkpoint' ? 'summary' : 'user'
        addEntry(
          state,
          options,
          kind,
          `[turn ${state.turn} ${kind === 'summary' ? 'compaction summary' : 'user'}]`,
          contentText(message?.content, options.includeReasoning),
        )
        break
      }
      case 'assistant/message': {
        const text = contentText(data.message?.content, options.includeReasoning)
        if (text.trim().length > 0) {
          addEntry(state, options, 'assistant', `[turn ${state.turn} step ${state.step} assistant]`, text)
        }
        break
      }
      case 'tool/call': {
        if (typeof data.callId === 'string') {
          state.pendingCalls.set(data.callId, {
            name: typeof data.name === 'string' ? data.name : 'tool',
            arguments: typeof data.arguments === 'string' ? data.arguments : '',
            turn: state.turn,
            step: state.step,
          })
        }
        break
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.callId
        const call = typeof callId === 'string' ? state.pendingCalls.get(callId) : undefined
        if (typeof callId === 'string') state.pendingCalls.delete(callId)
        const toolName = call?.name ?? 'tool'
        if (toolName === HISTORY_TOOL || toolName === SESSIONS_TOOL) break
        const args = argsPreview(call?.arguments)
        addEntry(
          state,
          options,
          'tool',
          `[turn ${call?.turn ?? state.turn} step ${call?.step ?? state.step} tool ${toolName}${args ? `(${args})` : ''}]`,
          contentText(data.message?.content, options.includeReasoning),
        )
        break
      }
      default:
        break
    }
  }
}

/** Small LRU over per-session entry states, bounded by session count and characters. */
function createEntryCache(config) {
  const sessions = new Map()
  let chars = 0

  function evict() {
    while (sessions.size > config.cacheSessions || chars > config.cacheChars) {
      const oldestId = sessions.keys().next().value
      if (oldestId === undefined) break
      chars -= sessions.get(oldestId).chars
      sessions.delete(oldestId)
    }
  }

  return {
    get(sessionId) {
      return sessions.get(sessionId)
    },
    touch(sessionId) {
      const entry = sessions.get(sessionId)
      if (entry === undefined) return
      sessions.delete(sessionId)
      sessions.set(sessionId, entry)
    },
    set(sessionId, state, nextSeq) {
      const prior = sessions.get(sessionId)
      if (prior !== undefined) {
        chars -= prior.chars
        sessions.delete(sessionId)
      }
      if (state.chars > config.cacheChars) return
      sessions.set(sessionId, { state, nextSeq, chars: state.chars, readAt: Date.now() })
      chars += state.chars
      evict()
    },
  }
}

/**
 * Read a session's entries, reusing the cached fold when nothing changed and
 * appending only the suffix when events were added. Falls back to a full fold
 * when the cached log is no longer a prefix of the observed log.
 */
async function loadEntries(ctx, cache, sessionId, options, liveSeq, persistedTtlMs) {
  const cached = cache.get(sessionId)
  if (cached !== undefined && liveSeq !== undefined && cached.nextSeq === liveSeq) {
    cache.touch(sessionId)
    return { state: cached.state }
  }
  if (cached !== undefined && liveSeq === undefined && persistedTtlMs > 0
    && Date.now() - cached.readAt < persistedTtlMs) {
    cache.touch(sessionId)
    return { state: cached.state }
  }

  let snapshot
  try {
    snapshot = await ctx.sessionQuery.readSession(sessionId)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []

  if (cached !== undefined) {
    if (cached.nextSeq === events.length) {
      cache.touch(sessionId)
      return { state: cached.state }
    }
    if (cached.nextSeq < events.length) {
      appendEntries(cached.state, events.slice(cached.nextSeq), options)
      cache.set(sessionId, cached.state, events.length)
      return { state: cached.state }
    }
  }

  const state = createEntryState()
  appendEntries(state, events, options)
  cache.set(sessionId, state, events.length)
  return { state }
}

/** Precompiled fast-path scan. The function is embedded so it runs under a vm deadline. */
const FAST_SCAN = (() => {
  try {
    return new vm.Script(`(${scanCore.toString()})(entries, pattern, offset, limit, countOnly, multiline)`)
  } catch {
    return undefined
  }
})()

/**
 * Try the in-process scan first. It avoids worker startup and a structured
 * clone of the whole history, which dominate warm-call latency. A vm timeout
 * bounds catastrophic backtracking; when it fires, the worker takes over so
 * the Host is not left blocked for the full search deadline.
 */
function searchFast(entries, pattern, options) {
  if (!options.fastPath || FAST_SCAN === undefined) return undefined
  try {
    return FAST_SCAN.runInNewContext({
      entries,
      pattern,
      offset: options.offset,
      limit: options.limit,
      countOnly: options.countOnly,
      multiline: options.multiline,
    }, { timeout: options.fastTimeoutMs })
  } catch (error) {
    if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return undefined
    if (error instanceof SyntaxError) return { error: `invalid regular expression: ${error.message}` }
    return { error: String(error?.message ?? error) }
  }
}

/**
 * Run the regex search in a worker so a pathological pattern or a very large
 * log can be terminated at the configured deadline instead of blocking the Host.
 */
function searchEntries(entries, pattern, options) {
  const fast = searchFast(entries, pattern, options)
  if (fast !== undefined) {
    return Promise.resolve(fast.error === undefined ? { kind: 'ok', ...fast } : { kind: 'error', message: fast.error })
  }

  return new Promise(resolve => {
    let settled = false
    let worker
    let timer
    const onAbort = () => finish({ kind: 'aborted' })

    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (worker !== undefined) worker.terminate().catch(() => {})
      resolve(result)
    }

    try {
      worker = new Worker(new URL('./grep-worker.mjs', import.meta.url), {
        workerData: {
          entries,
          pattern,
          offset: options.offset,
          limit: options.limit,
          countOnly: options.countOnly,
          multiline: options.multiline,
        },
      })
    } catch (error) {
      resolve({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      return
    }

    timer = setTimeout(() => finish({ kind: 'timeout' }), options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    worker.once('message', message => {
      if (message?.error) finish({ kind: 'error', message: String(message.error) })
      else finish({ kind: 'ok', ...message })
    })
    worker.once('error', error => finish({ kind: 'error', message: error?.message ?? String(error) }))
    worker.once('exit', code => {
      if (!settled) finish({ kind: 'error', message: `search worker exited with code ${code}` })
    })
  })
}

/** Clip one display line around the match without changing the stored log. */
function clipLine(line, column, lineChars) {
  if (line.length <= lineChars) return line
  const start = column === undefined
    ? 0
    : Math.max(0, Math.min(column - Math.floor(lineChars / 3), line.length - lineChars))
  return `${start > 0 ? '...' : ''}${line.slice(start, start + lineChars)}${start + lineChars < line.length ? '...' : ''}`
}

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm
}

function summarize(total, entryCount, byKind, sessionCount, multiline) {
  const noun = multiline ? 'match' : 'line'
  const nounPlural = multiline ? 'matches' : 'lines'
  const parts = Object.entries(byKind ?? {})
    .sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => `${count} in ${KIND_LABELS[kind] ?? kind}`)
  const sessions = sessionCount !== undefined && sessionCount > 1 ? ` across ${sessionCount} sessions` : ''
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `${total} matching ${total === 1 ? noun : nounPlural} in ${entryCount} history ${plural(entryCount, 'entry', 'entries')}${sessions}${detail}.`
}

function shortId(sessionId) {
  const text = String(sessionId)
  return `session ${text.slice(0, 8)}`
}

/**
 * Format a page the way GrepMem renders recall: a summary, then session and
 * entry headers, with numbered lines and explicit match/context markers.
 */
function formatResult(entries, pattern, config, args, result, labels) {
  switch (result.kind) {
    case 'aborted':
      return 'Error: history search was cancelled.'
    case 'timeout':
      return `Error: /${pattern}/ did not finish within ${config.timeoutMs}ms; use a simpler, more specific pattern.`
    case 'error':
      return `Error: ${result.message}`
    default:
      break
  }

  const { total, page, entryCount, byKind, sessionCount } = result
  if (total === 0) return `No matches for /${pattern}/.`

  const head = summarize(total, entryCount, byKind, sessionCount, args.multiline)
  if (args.countOnly) return head
  if (args.offset >= total) return `${head}\nNo matches at offset=${args.offset}.`

  const out = [head]
  let size = head.length
  let shown = 0
  let lastEntry = -1
  let lastEnd = 0
  let lastSession

  for (const [entryIndex, lineIndex, column] of page) {
    if (shown >= config.maxMatches) break
    const entry = entries[entryIndex]
    if (entry === undefined) continue
    const lines = entry.lines
    const start = Math.max(0, lineIndex - args.contextLines)
    const end = Math.min(lines.length, lineIndex + args.contextLines + 1)
    const parts = []

    if (labels !== undefined && entry.sessionId !== lastSession) {
      parts.push(`## ${labels.get(entry.sessionId) ?? shortId(entry.sessionId)}`)
      lastSession = entry.sessionId
      lastEntry = -1
      lastEnd = 0
    }

    if (entryIndex !== lastEntry) {
      parts.push(`== ${entry.header}`)
      lastEntry = entryIndex
      lastEnd = 0
    } else if (start > lastEnd) {
      parts.push('  --')
    }

    const from = Math.min(Math.max(start, lastEnd), lineIndex)
    for (let index = from; index < end; index += 1) {
      const isMatch = index === lineIndex
      parts.push(`  ${index + 1}${isMatch ? ':' : '-'} ${clipLine(lines[index], isMatch ? column : undefined, config.lineChars)}`)
    }
    lastEnd = Math.max(lastEnd, end)

    const block = parts.join('\n')
    if (out.length > 1 && size + block.length > config.resultChars) break
    out.push(block)
    size += block.length + 1
    shown += 1
  }

  if (shown === 0) return head
  const end = args.offset + shown
  const footer = end < total
    ? `(showing matches ${args.offset + 1}-${end} of ${total}; call again with offset=${end} for more)`
    : `(showing matches ${args.offset + 1}-${end} of ${total})`
  out.push(footer)
  return out.join('\n')
}

function parseArgs(args, config) {
  return {
    pattern: typeof args?.pattern === 'string' ? args.pattern : '',
    maxMatches: integerArgument(args?.max_matches, config.maxMatches, 1, config.maxMatches),
    offset: integerArgument(args?.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    contextLines: integerArgument(args?.context_lines, 1, 0, config.maxContextLines),
    countOnly: booleanArgument(args?.count),
    multiline: booleanArgument(args?.multiline),
  }
}

function validatePattern(pattern) {
  if (pattern.length === 0) return 'Error: pattern must be a non-empty regular expression.'
  if (pattern.length > 2000) return 'Error: pattern is too long; use a shorter, more specific expression.'
  return undefined
}

function searchOptions(parsed, config) {
  return {
    offset: parsed.offset,
    limit: parsed.maxMatches,
    countOnly: parsed.countOnly,
    multiline: parsed.multiline,
    timeoutMs: config.timeoutMs,
    fastPath: config.fastPath,
    fastTimeoutMs: config.fastTimeoutMs,
  }
}

/** `grep_history`: this session's raw log. */
async function executeHistory(ctx, args, exec, config, cache) {
  const parsed = parseArgs(args, config)
  const invalid = validatePattern(parsed.pattern)
  if (invalid !== undefined) return invalid

  const agent = exec?.agent
  const sessionId = agent?.session?.id
  if (sessionId === undefined) {
    return 'Error: grep_history needs an agent-bound session, but this call has none.'
  }

  const loaded = await loadEntries(
    ctx,
    cache,
    sessionId,
    { includeReasoning: config.includeReasoning, sessionId },
    agent.session.seq,
    config.persistedCacheTtlMs,
  )
  if (loaded.error !== undefined) return `Error: could not read this session's history: ${loaded.error}`

  const entries = loaded.state.entries
  const result = await searchEntries(entries, parsed.pattern, {
    ...searchOptions(parsed, config),
    signal: exec?.signal,
  })
  return formatResult(entries, parsed.pattern, config, parsed, result)
}

/** `grep_sessions`: earlier sessions with the exact same working directory. */
async function executeSessions(ctx, args, exec, config, cache) {
  const parsed = parseArgs(args, config)
  const invalid = validatePattern(parsed.pattern)
  if (invalid !== undefined) return invalid

  const caller = exec?.agent?.session
  if (caller === undefined) return 'Error: grep_sessions needs an agent-bound session, but this call has none.'
  const cwd = caller.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return 'Error: grep_sessions requires a session with a working directory.'
  }

  const maxSessions = integerArgument(args?.max_sessions, config.maxSessions, 1, config.maxSessions)
  const includeChildren = booleanArgument(args?.include_child_sessions)

  let records
  try {
    records = await ctx.sessionQuery.filterSessions([{ kind: 'cwd', values: [cwd] }], exec.signal)
  } catch (error) {
    return `Error: could not list workspace sessions: ${error instanceof Error ? error.message : String(error)}`
  }

  const targets = records
    .filter(record => record.header.id !== caller.id)
    .filter(record => includeChildren || (record.header.parentSession === undefined && record.header.origin !== 'subagent'))
    .slice(0, maxSessions)

  if (targets.length === 0) return 'No earlier sessions in this workspace.'

  const merged = []
  let unreadable = 0
  for (const record of targets) {
    const sessionId = record.header.id
    const liveAgent = ctx.agents.get(sessionId)
    const loaded = await loadEntries(
      ctx,
      cache,
      sessionId,
      { includeReasoning: config.includeReasoning, sessionId },
      liveAgent?.session?.seq,
      config.persistedCacheTtlMs,
    )
    if (loaded.error !== undefined) {
      unreadable += 1
      continue
    }
    for (const entry of loaded.state.entries) merged.push(entry)
  }

  if (merged.length === 0) return `No readable history in ${targets.length} earlier session(s).`

  const result = await searchEntries(merged, parsed.pattern, {
    ...searchOptions(parsed, config),
    signal: exec?.signal,
  })

  let labels
  if (result.kind === 'ok' && !parsed.countOnly) {
    labels = new Map()
    const hitIds = new Set(result.page.map(hit => merged[hit[0]]?.sessionId).filter(Boolean))
    for (const sessionId of hitIds) {
      try {
        const title = await ctx.sessionQuery.readTitle(sessionId, exec.signal)
        labels.set(sessionId, title?.title ?? shortId(sessionId))
      } catch {
        labels.set(sessionId, shortId(sessionId))
      }
    }
  }

  const output = formatResult(merged, parsed.pattern, config, parsed, result, labels)
  return unreadable > 0 ? `${output}\n(${unreadable} session(s) could not be read and were skipped.)` : output
}

/** Place recall guidance next to the file-grep tool, falling back on older Harness versions. */
function promptOrder(ctx) {
  try {
    const order = ctx.systemPrompt.getSectionOrder?.('TOOL_GREP')
    if (Number.isFinite(order)) return order + 1
  } catch {
    // An older systemPrompt without the named placement still gets a stable slot.
  }
  return 1510
}

/** Register both recall tools and their shared prompt guidance. */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  const cache = createEntryCache(resolved)

  ctx.systemPrompt.section({
    name: 'grepmem:recall',
    order: promptOrder(ctx),
    text: PROMPT_TEXT,
  })

  ctx.tools.register({
    name: HISTORY_TOOL,
    description: HISTORY_DESCRIPTION,
    parameters: HISTORY_PARAMETERS,
    output: OUTPUT,
    timeoutMs: resolved.timeoutMs + 5000,
    execute: (args, exec) => executeHistory(ctx, args, exec, resolved, cache),
  })

  ctx.tools.register({
    name: SESSIONS_TOOL,
    description: SESSIONS_DESCRIPTION,
    parameters: SESSIONS_PARAMETERS,
    output: OUTPUT,
    timeoutMs: resolved.timeoutMs + 15_000,
    execute: (args, exec) => executeSessions(ctx, args, exec, resolved, cache),
  })

  if (resolved.compactionNudge) installCompactionNudge(ctx)
}

/**
 * Best-effort policy substitute for the paper's trained recall policy: after a
 * compaction, queue one short notice so the next step knows the removed
 * history is still greppable. Injection never wakes an idle agent, and a
 * disposed agent or rejected message is ignored.
 */
function installCompactionNudge(ctx) {
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'compaction/end' || session?.id === undefined) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    try {
      agent.inject({
        id: `grepmem-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: NUDGE_TEXT }],
        source: { kind: 'grepmem', form: 'notice' },
      })
    } catch {
      // A disposed agent or a rejected injection must not affect compaction.
    }
  })
}
