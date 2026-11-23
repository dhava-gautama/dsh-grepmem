import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'

function harness(events, config = {}) {
  let tool
  const ctx = {
    systemPrompt: {
      section() {},
      getSectionOrder() {
        return 1500
      },
    },
    tools: {
      register(definition) {
        tool = definition
      },
    },
    sessionQuery: {
      async readSession() {
        return { events }
      },
    },
  }
  apply(ctx, config)
  return tool
}

const exec = { agent: { session: { id: 'test-session' } }, signal: new AbortController().signal }

function events() {
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

test('groups matches by turn and tool header', async () => {
  const tool = harness(events())
  const text = await tool.execute({ pattern: 'rotate-42' }, exec)
  assert.match(text, /^3 matching lines in 3 history entries/)
  assert.match(text, /\[turn 1 user\]/)
  assert.match(text, /\[turn 1 step 1 tool bash\(\{"command":"cat config"\}\)\]/)
  assert.match(text, /\[turn 2 compaction summary\]/)
  assert.match(text, /\(showing matches 1-3 of 3\)/)
})

test('excludes earlier grep_history output', async () => {
  const tool = harness(events())
  const text = await tool.execute({ pattern: 'echoed rotate-42' }, exec)
  assert.match(text, /^No matches for/)
})

test('count returns only the summary', async () => {
  const tool = harness(events())
  const text = await tool.execute({ pattern: 'rotate-42', count: true }, exec)
  assert.match(text, /^3 matching lines in 3 history entries/)
  assert.doesNotMatch(text, /==/)
})

test('pages with offset and reports the next offset', async () => {
  const tool = harness(events())
  const text = await tool.execute({ pattern: 'rotate-42', max_matches: 1 }, exec)
  assert.match(text, /offset=1/)
  const beyond = await tool.execute({ pattern: 'rotate-42', offset: 99 }, exec)
  assert.match(beyond, /No matches at offset=99/)
})

test('reports invalid regular expressions without throwing', async () => {
  const tool = harness(events())
  const text = await tool.execute({ pattern: '(' }, exec)
  assert.match(text, /^Error: invalid regular expression/)
})

test('enforces configured caps', async () => {
  const tool = harness(events(), { maxMatches: 99, maxContextLines: 9 })
  const text = await tool.execute({ pattern: 'rotate-42', max_matches: 99, context_lines: 9 }, exec)
  assert.match(text, /\(showing matches 1-3 of 3\)/)
})

test('terminates a pathological pattern at the deadline', async () => {
  const tool = harness([
    {
      type: 'user/message',
      data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'a'.repeat(64) + '!' }] } },
    },
  ], { timeoutMs: 1000 })
  const started = Date.now()
  const text = await tool.execute({ pattern: '(a+)+$' }, exec)
  assert.match(text, /did not finish/)
  assert.ok(Date.now() - started < 5000)
})
