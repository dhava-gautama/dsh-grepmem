/**
 * GrepMem for DeepSeek Harness.
 *
 * DSH already keeps an append-only, replay-validated session log, and its
 * compaction backend replaces older history on the model surface without
 * deleting those events. This plugin adds the missing half of GrepMem: an
 * index-free `grep_history` tool that regex-searches the complete raw log of
 * the calling session, including content that compaction removed from context.
 *
 * No embeddings, index, extra model request, or session event is created. The
 * log stays the source of truth; this plugin only reads it on demand.
 *
 * @module @local/dsh-grepmem
 */

import { Worker } from 'node:worker_threads'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'grepmem'

/** Host services this plugin needs. `sessionQuery` provides replay-validated log reads. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery']

const DEFAULTS = Object.freeze({
  enabled: true,
  maxMatches: 10,
  maxContextLines: 3,
  lineChars: 300,
  resultChars: 6000,
  timeoutMs: 10_000,
  includeReasoning: false,
})

const LIMITS = Object.freeze({
  maxMatches: 30,
  maxContextLines: 3,
  lineChars: 2000,
  resultChars: 40_000,
  timeoutMs: 60_000,
})

const TOOL_NAME = 'grep_history'

const KIND_LABELS = Object.freeze({
  user: 'user messages',
  assistant: 'your replies',
  tool: 'tool outputs',
  summary: 'summaries',
})

const PROMPT_TEXT = [
  'Your session history is kept in a complete log even after older context is compacted.',
  'When an exact detail is missing from context - a name, number, ID, path, URL, error, or earlier tool',
  'result - call grep_history with a specific case-insensitive regex instead of guessing or redoing work.',
].join('\n')

const TOOL_DESCRIPTION = [
  'Search the complete, uncompressed log of this session with a case-insensitive regular expression.',
  'It covers user messages, assistant replies, and tool output that compaction has removed from context;',
  'earlier grep_history results are excluded. Matches are grouped by turn and tool call, and paged with',
  'offset. Use it to recover exact details - names, numbers, IDs, paths, URLs, errors - instead of guessing.',
].join(' ')

const PARAMETERS = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Case-insensitive JavaScript regular expression. Prefer exact strings you saw before: names, numbers, IDs, paths, URLs, error text.',
    },
    max_matches: {
      type: 'integer',
      description: 'Matching lines to show. Defaults to 10, at most 30.',
    },
    offset: {
      type: 'integer',
      description: 'Skip this many matching lines. Use the offset in the result footer to get the next page.',
    },
    context_lines: {
      type: 'integer',
      description: 'Lines of context around each matching line. Defaults to 1, at most 3.',
    },
    count: {
      type: 'boolean',
      description: 'Return only the number of matching lines. Defaults to false.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
}

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Resolve the deployment config with bounds, so a bad row cannot make one call
 * scan or render without limit.
 * @param {unknown} raw - Loader-supplied config object.
 */
function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: config.enabled !== false,
    maxMatches: clampInteger(config.maxMatches, DEFAULTS.maxMatches, 1, LIMITS.maxMatches),
    maxContextLines: clampInteger(config.maxContextLines, DEFAULTS.maxContextLines, 0, LIMITS.maxContextLines),
    lineChars: clampInteger(config.lineChars, DEFAULTS.lineChars, 80, LIMITS.lineChars),
    resultChars: clampInteger(config.resultChars, DEFAULTS.resultChars, 500, LIMITS.resultChars),
    timeoutMs: clampInteger(config.timeoutMs, DEFAULTS.timeoutMs, 1000, LIMITS.timeoutMs),
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
 * Turn raw session events into GrepMem-style history entries: a label plus the
 * lines that produced it. Events hidden from the surface by compaction are
 * included; earlier grep_history output is skipped to avoid echoing recalls.
 * @param {readonly any[]} events - raw SessionEvents from sessionQuery.
 * @param {{ includeReasoning: boolean }} options
 */
function buildEntries(events, options) {
  const entries = []
  const pendingCalls = new Map()
  let turn = 0
  let step = 0

  for (const event of events) {
    const data = event?.data
    if (data === null || typeof data !== 'object') continue
    switch (event.type) {
      case 'turn/start':
        if (Number.isInteger(data.turn)) turn = data.turn
        break
      case 'step/start':
        if (Number.isInteger(data.step)) step = data.step
        break
      case 'user/message': {
        const message = data.message
        const sourceKind = message?.source?.kind
        const kind = sourceKind === 'compact-checkpoint' ? 'summary' : 'user'
        const label = kind === 'summary' ? 'compaction summary' : 'user'
        entries.push({
          kind,
          header: `[turn ${turn} ${label}]`,
          lines: splitLines(contentText(message?.content, options.includeReasoning)),
        })
        break
      }
      case 'assistant/message': {
        const text = contentText(data.message?.content, options.includeReasoning)
        if (text.trim().length === 0) break
        entries.push({
          kind: 'assistant',
          header: `[turn ${turn} step ${step} assistant]`,
          lines: splitLines(text),
        })
        break
      }
      case 'tool/call': {
        if (typeof data.callId === 'string') {
          pendingCalls.set(data.callId, {
            name: typeof data.name === 'string' ? data.name : 'tool',
            arguments: typeof data.arguments === 'string' ? data.arguments : '',
            turn,
            step,
          })
        }
        break
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.callId
        const call = typeof callId === 'string' ? pendingCalls.get(callId) : undefined
        if (typeof callId === 'string') pendingCalls.delete(callId)
        const toolName = call?.name ?? 'tool'
        if (toolName === TOOL_NAME) break
        const entryTurn = call?.turn ?? turn
        const entryStep = call?.step ?? step
        const args = argsPreview(call?.arguments)
        entries.push({
          kind: 'tool',
          header: `[turn ${entryTurn} step ${entryStep} tool ${toolName}${args ? `(${args})` : ''}]`,
          lines: splitLines(contentText(data.message?.content, options.includeReasoning)),
        })
        break
      }
      default:
        break
    }
  }

  return entries
}

/**
 * Run the regex search in a worker so a pathological pattern or a very large
 * log can be terminated at the configured deadline instead of blocking the Host.
 * @returns {Promise<{ kind: 'ok', total: number, page: number[][], entryCount: number, byKind: Record<string, number> }
 *   | { kind: 'timeout' } | { kind: 'aborted' } | { kind: 'error', message: string }>}
 */
function searchEntries(entries, pattern, options) {
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
function clipLine(line, matchIndex, lineChars) {
  if (line.length <= lineChars) return line
  const start = matchIndex === undefined
    ? 0
    : Math.max(0, Math.min(matchIndex - Math.floor(lineChars / 3), line.length - lineChars))
  return `${start > 0 ? '...' : ''}${line.slice(start, start + lineChars)}${start + lineChars < line.length ? '...' : ''}`
}

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm
}

function summarize(total, entryCount, byKind) {
  const parts = Object.entries(byKind)
    .sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => `${count} in ${KIND_LABELS[kind] ?? kind}`)
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `${total} matching line${total === 1 ? '' : 's'} in ${entryCount} history ${plural(entryCount, 'entry', 'entries')}${detail}.`
}

/**
 * Format a page the way GrepMem renders recall: a summary, then entries under
 * `== [header]`, with numbered lines and explicit match/context markers.
 */
function formatResult(entries, pattern, config, args, result) {
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

  const { total, page, entryCount, byKind } = result
  if (total === 0) return `No matches for /${pattern}/.`

  const head = summarize(total, entryCount, byKind ?? {})
  if (args.countOnly) return head
  if (args.offset >= total) return `${head}\nNo matches at offset=${args.offset}.`

  const out = [head]
  let size = head.length
  let shown = 0
  let lastEntry = -1
  let lastEnd = 0

  for (const [entryIndex, lineIndex, matchIndex] of page) {
    if (shown >= config.maxMatches) break
    const entry = entries[entryIndex]
    if (entry === undefined) continue
    const lines = entry.lines
    const start = Math.max(0, lineIndex - args.contextLines)
    const end = Math.min(lines.length, lineIndex + args.contextLines + 1)
    const parts = []

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
      parts.push(`  ${index + 1}${isMatch ? ':' : '-'} ${clipLine(lines[index], isMatch ? matchIndex : undefined, config.lineChars)}`)
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

/** Register the recall tool and its short system-prompt guidance. */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  ctx.systemPrompt.section({
    name: 'grepmem:recall',
    order: promptOrder(ctx),
    text: PROMPT_TEXT,
  })

  ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    timeoutMs: resolved.timeoutMs + 5000,
    async execute(args, exec) {
      const pattern = typeof args?.pattern === 'string' ? args.pattern : ''
      if (pattern.length === 0) return 'Error: pattern must be a non-empty regular expression.'
      if (pattern.length > 2000) return 'Error: pattern is too long; use a shorter, more specific expression.'

      const agent = exec?.agent
      const sessionId = agent?.session?.id
      if (sessionId === undefined) {
        return 'Error: grep_history needs an agent-bound session, but this call has none.'
      }

      const maxMatches = integerArgument(args.max_matches, resolved.maxMatches, 1, resolved.maxMatches)
      const offset = integerArgument(args.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const contextLines = integerArgument(args.context_lines, 1, 0, resolved.maxContextLines)
      const countOnly = args.count === true || args.count === 'true'

      let snapshot
      try {
        snapshot = await ctx.sessionQuery.readSession(sessionId)
      } catch (error) {
        return `Error: could not read this session's history: ${error instanceof Error ? error.message : String(error)}`
      }

      const entries = buildEntries(snapshot?.events ?? [], resolved)
      const search = await searchEntries(entries, pattern, {
        offset,
        limit: maxMatches,
        countOnly,
        timeoutMs: resolved.timeoutMs,
        signal: exec?.signal,
      })

      return formatResult(entries, pattern, resolved, { offset, contextLines, countOnly }, search)
    },
  })
}
