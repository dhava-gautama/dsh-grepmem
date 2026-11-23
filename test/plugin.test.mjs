import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'

function baseEvents() {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Deploy key rotate-42 for staging.' }] } },
    },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { source: { kind: 'model' }, content: [{ type: 'text', text: 'I will inspect the config.' }] } },
    },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"cat config"}' } },
    {
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'API_KEY=rotate-42\nregion=eu-west-1' }] } },
    },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c2', name: 'grep_history', arguments: '{"pattern":"rotate-42"}' } },
    {
      type: 'tool/result',
      data: { turn: 1, step: 1, message: { toolCallId: 'c2', content: [{ type: 'text', text: 'echoed rotate-42 recall output' }] } },
    },
    { type: 'compaction/start', data: {} },
    { type: 'compaction/end', data: {} },
    { type: 'turn/start', data: { turn: 2 } },
    {
      type: 'user/message',
      data: { message: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'Summary: staging uses rotate-42.' }] } },
    },
  ]
}

function harness({ events = {}, records = [], titles = {}, config = {}, liveSeqs = {} } = {}) {
  const tools = new Map()
  const reads = []
  const ctx = {
    systemPrompt: {
      section() {},
      getSectionOrder() {
        return 1500
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
      },
    },
    sessionQuery: {
      async readSession(sessionId) {
        reads.push(sessionId)
        const value = events[sessionId]
        if (value === undefined) throw new Error(`missing session ${sessionId}`)
        return { events: value }
      },
      async filterSessions() {
        return records
      },
      async readTitle(sessionId) {
        const title = titles[sessionId]
        return title === undefined ? undefined : { title }
      },
    },
    agents: {
      get(sessionId) {
        const seq = liveSeqs[sessionId]
        return seq === undefined ? undefined : { session: { seq } }
      },
    },
  }
  apply(ctx, config)
  return { tools, reads }
}

function execFor(sessionId = 'test-session', { cwd = '/work', seq } = {}) {
  const session = { id: sessionId, header: { cwd } }
  if (seq !== undefined) session.seq = seq
  return { agent: { session }, signal: new AbortController().signal }
}

test('groups matches by turn and tool header', async () => {
  const { tools } = harness({ events: { s1: baseEvents() } })
  const text = await tools.get('grep_history').execute({ pattern: 'rotate-42' }, execFor('s1'))
  assert.match(text, /^3 matching lines in 3 history entries/)
  assert.match(text, /\[turn 1 user\]/)
  assert.match(text, /\[turn 1 step 1 tool bash\(\{"command":"cat config"\}\)\]/)
  assert.match(text, /\[turn 2 compaction summary\]/)
  assert.match(text, /\(showing matches 1-3 of 3\)/)
})

test('excludes earlier grep_history output', async () => {
  const { tools } = harness({ events: { s1: baseEvents() } })
  const text = await tools.get('grep_history').execute({ pattern: 'echoed rotate-42' }, execFor('s1'))
  assert.match(text, /^No matches for/)
})

test('count returns only the summary', async () => {
  const { tools } = harness({ events: { s1: baseEvents() } })
  const text = await tools.get('grep_history').execute({ pattern: 'rotate-42', count: true }, execFor('s1'))
  assert.match(text, /^3 matching lines in 3 history entries/)
  assert.doesNotMatch(text, /==/)
})

test('pages with offset and reports the next offset', async () => {
  const { tools } = harness({ events: { s1: baseEvents() } })
  const tool = tools.get('grep_history')
  const text = await tool.execute({ pattern: 'rotate-42', max_matches: 1 }, execFor('s1'))
  assert.match(text, /offset=1/)
  const beyond = await tool.execute({ pattern: 'rotate-42', offset: 99 }, execFor('s1'))
  assert.match(beyond, /No matches at offset=99/)
})

test('reports invalid regular expressions without throwing', async () => {
  const { tools } = harness({ events: { s1: baseEvents() } })
  const text = await tools.get('grep_history').execute({ pattern: '(' }, execFor('s1'))
  assert.match(text, /^Error: invalid regular expression/)
})

test('enforces configured caps', async () => {
  const { tools } = harness({
    events: { s1: baseEvents() },
    config: { maxMatches: 99, maxContextLines: 9 },
  })
  const text = await tools.get('grep_history').execute(
    { pattern: 'rotate-42', max_matches: 99, context_lines: 9 },
    execFor('s1'),
  )
  assert.match(text, /\(showing matches 1-3 of 3\)/)
})

test('multiline lets a pattern span lines', async () => {
  const events = {
    s1: [{
      type: 'user/message',
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'alpha\nbeta\ngamma' }] } },
    }],
  }
  const { tools } = harness({ events })
  const inline = await tools.get('grep_history').execute({ pattern: 'alpha\\nbeta' }, execFor('s1'))
  assert.match(inline, /^No matches/)
  const multiline = await tools.get('grep_history').execute(
    { pattern: 'alpha\\nbeta', multiline: true },
    execFor('s1'),
  )
  assert.match(multiline, /^1 matching match in 1 history entry/)
  assert.match(multiline, /1: alpha/)
})

test('reuses the cached fold and appends only new events', async () => {
  const events = { s1: baseEvents() }
  const liveSeqs = { s1: events.s1.length }
  const { tools, reads } = harness({ events, liveSeqs })
  const tool = tools.get('grep_history')

  await tool.execute({ pattern: 'rotate-42' }, execFor('s1', { seq: liveSeqs.s1 }))
  assert.equal(reads.length, 1)
  await tool.execute({ pattern: 'rotate-42' }, execFor('s1', { seq: liveSeqs.s1 }))
  assert.equal(reads.length, 1)

  events.s1.push({
    type: 'user/message',
    data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'later detail zeta-9' }] } },
  })
  liveSeqs.s1 = events.s1.length
  const text = await tool.execute({ pattern: 'zeta-9' }, execFor('s1', { seq: liveSeqs.s1 }))
  assert.equal(reads.length, 2)
  assert.match(text, /zeta-9/)
})

test('searches earlier workspace sessions and excludes children', async () => {
  const events = {
    s1: baseEvents(),
    s2: [{
      type: 'user/message',
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Earlier note omega-7' }] } },
    }],
    s3: [{
      type: 'user/message',
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Child note omega-7' }] } },
    }],
  }
  const records = [
    { header: { id: 's2', cwd: '/work', createdAt: 3 } },
    { header: { id: 's3', cwd: '/work', createdAt: 2, parentSession: 's1', origin: 'subagent' } },
    { header: { id: 's1', cwd: '/work', createdAt: 1 } },
  ]
  const { tools } = harness({
    events,
    records,
    titles: { s2: 'Earlier work' },
    liveSeqs: {},
  })
  const text = await tools.get('grep_sessions').execute({ pattern: 'omega-7' }, execFor('s1'))
  assert.match(text, /^1 matching line in 1 history entry \(1 in user messages\)\./)
  assert.match(text, /## Earlier work/)
  assert.match(text, /Earlier note omega-7/)
  assert.doesNotMatch(text, /Child note/)
})

test('grep_sessions can include child sessions', async () => {
  const events = {
    s1: baseEvents(),
    s2: [{
      type: 'user/message',
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Child note omega-7' }] } },
    }],
  }
  const records = [
    { header: { id: 's2', cwd: '/work', createdAt: 2, parentSession: 's1', origin: 'subagent' } },
    { header: { id: 's1', cwd: '/work', createdAt: 1 } },
  ]
  const { tools } = harness({ events, records, titles: { s2: 'Child work' } })
  const text = await tools.get('grep_sessions').execute(
    { pattern: 'omega-7', include_child_sessions: true },
    execFor('s1'),
  )
  assert.match(text, /## Child work/)
  assert.match(text, /Child note omega-7/)
})

test('grep_sessions requires a working directory', async () => {
  const { tools } = harness({ events: { s1: baseEvents() } })
  const text = await tools.get('grep_sessions').execute({ pattern: 'x' }, execFor('s1', { cwd: null }))
  assert.match(text, /requires a session with a working directory/)
})

test('terminates a pathological pattern at the deadline', async () => {
  const { tools } = harness({
    events: {
      s1: [{
        type: 'user/message',
        data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(64) + '!' }] } },
      }],
    },
    config: { timeoutMs: 1000 },
  })
  const started = Date.now()
  const text = await tools.get('grep_history').execute({ pattern: '(a+)+$' }, execFor('s1'))
  assert.match(text, /did not finish/)
  assert.ok(Date.now() - started < 5000)
})
