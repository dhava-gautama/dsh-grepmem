# GrepMem history recall

A DeepSeek Harness plugin that adds **lossless, index-free recall over session history**.

DSH already compacts long conversations: older messages are replaced on the model surface by a summary, while the original events stay in the append-only session log. This plugin adds the missing piece from [GrepMem](https://github.com/limenlp/GrepMem): regex search over that complete log, including content compaction removed from context.

No embeddings, vector index, memory extraction, or extra model request. Nothing is written to the session; the log remains the only source of truth.

## Install

Clone the repository, then install the directory through **Plugins** in DSH:

```bash
git clone https://github.com/dhava-gautama/dsh-grepmem
```

1. Open **Plugins → Add plugin**.
2. Choose the cloned `dsh-grepmem` directory.
3. Enable **GrepMem history recall** if it is not enabled automatically.

Installing adds two tools and a short system-prompt section to every agent in the profile. Turning the bundle off removes all three.

## Tools

### `grep_history` — this session

Searches the current session's complete raw log, including messages and tool output that compaction removed from the model surface. Earlier `grep_history`/`grep_sessions` **tool results** are excluded. Text quoted in other messages — for example a subagent report — is still searchable, so a repeated search can surface a previous answer.

```text
grep_history(pattern="budget-17", context_lines=2)
grep_history(pattern="ECONNREFUSED|timeout", max_matches=20, offset=0)
grep_history(pattern="api\\.example\\.com", count=true)
grep_history(pattern="BEGIN[\\s\\S]*?END", multiline=true)
```

- `pattern` — case-insensitive JavaScript regular expression. Exact strings work best: names, numbers, IDs, paths, URLs, error text.
- `max_matches` — matching lines (or matches in multiline mode) to show. Default 10.
- `offset` — skip matches; the footer reports the next offset.
- `context_lines` — lines around each match. Default 1, at most 3.
- `count` — return only the count.
- `multiline` — let the pattern span line boundaries inside one history entry. Each regex match is then one hit, and `.` also matches newlines.

### `grep_sessions` — earlier sessions in the workspace

Searches the complete logs of earlier sessions whose working directory exactly matches the caller's, newest first. This is the cross-session answer to “we solved this before, where was it?”. Child, forked, and subagent sessions are excluded by default; pass `include_child_sessions=true` to include them.

```text
grep_sessions(pattern="rotate-42")
grep_sessions(pattern="deploy .* staging", max_sessions=4, context_lines=2)
```

`grep_sessions` uses the same `pattern`, `max_matches`, `offset`, `context_lines`, `count`, and `multiline` arguments, plus:

- `max_sessions` — sessions to search, newest first. Default and cap come from config (`maxSessions`, default 6).
- `include_child_sessions` — also search forked and subagent sessions. Default false.

Authorization is conservative: the working directory must match exactly, the calling session is never included, and sessions from other workspaces are never read.

## Output

Matches are grouped by session (for `grep_sessions`), then by the turn and tool call that produced them, with line numbers:

```text
3 matching lines in 3 history entries (1 in user messages, 1 in tool outputs, 1 in summaries).
## Earlier work
== [turn 1 step 1 tool bash({"command":"cat config"})]
  1: API_KEY=rotate-42
  2- region=eu-west-1
(showing matches 1-3 of 3; call again with offset=3 for more)
```

Long lines are clipped around the match for display; the stored history is unchanged.

## Performance and caching

The plugin keeps a small LRU of folded session entries (default: 6 sessions, 16 MB). Repeated calls reuse the fold; when new events arrive, only the appended suffix is processed. A live session's next sequence number skips the read entirely when nothing changed. A persisted session is reused for `persistedCacheTtlMs` (default 15 s) before it is read again, so a burst of cross-session searches does not rescan every log. A cold read of a very large session still costs proportional time and memory, but it happens once per cache lifetime, not once per call. Entries larger than `cacheChars` are not cached.

Normal searches run in-process inside a `vm` context with a short watchdog (`fastTimeoutMs`, default 200 ms). That avoids worker startup and a structured clone of the whole history, which dominate warm-call latency. On a synthetic 32 MiB log, a warm scan dropped from ~230 ms to ~45 ms; at 4 MiB it is ~3 ms. If the fast path hits its deadline — a pathological pattern or a very large log — the worker fallback runs with the full `timeoutMs` and cannot block the Host. The fast path may block the Host for up to `fastTimeoutMs` before that fallback starts.

Reading logs and folding entries happen on the Host thread and are not interruptible by either deadline.

## Configuration

Set these in the profile's `cordis.patch.yml` under the `grepmem` row:

```yaml
- id: grepmem
  config:
    maxMatches: 20
    maxSessions: 4
    timeoutMs: 5000
```

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Register both tools and the prompt section. |
| `maxMatches` | `10` | Default and per-call maximum matches (1–30). |
| `maxContextLines` | `3` | Maximum `context_lines` a call may request (0–3). |
| `lineChars` | `300` | Display width of one line before clipping around the match (80–2000). |
| `resultChars` | `6000` | Soft budget for one rendered page (500–40000). |
| `timeoutMs` | `10000` | Worker-fallback deadline for one search (1000–60000). |
| `fastPath` | `true` | Scan in-process under a `vm` watchdog before falling back to the worker. |
| `fastTimeoutMs` | `200` | Watchdog for the in-process scan (50–5000). |
| `maxSessions` | `6` | Default and maximum sessions per `grep_sessions` call (1–25). |
| `cacheSessions` | `6` | Folded session logs kept in the LRU (1–24). |
| `cacheChars` | `16000000` | Approximate character budget of the LRU (1 MB–128 MB). |
| `persistedCacheTtlMs` | `15000` | Reuse a persisted session's fold for this long before re-reading (0–300000; 0 disables). |
| `compactionNudge` | `true` | Queue a short "history is still greppable" notice after compaction. Never wakes an idle agent. |
| `includeReasoning` | `false` | Also search assistant reasoning blocks, when present. |

## How it works

1. `sessionQuery.readSession()` returns the replay-validated raw log of a session. It prefers the live session, so unflushed events are included.
2. Raw events are folded into entries: user messages, assistant replies, compaction summaries, and one entry per tool result paired with its call. Content compaction shadowed stays available because the raw log is read, not the model surface.
3. The fold is cached per session and extended by suffix on later calls. A live session's next sequence number skips the read entirely when nothing changed; a persisted session is read again, but its fold is reused when the log length is unchanged.
4. The regex runs in-process under a `vm` watchdog (line mode or multiline). If it exceeds `fastTimeoutMs`, a worker retries with the full `timeoutMs`. The page renderer labels sessions and turns, clips long lines, and stops at `resultChars`.
5. After a compaction, the plugin best-effort queues one short user-role notice saying the removed history is still greppable. It is queued for the next pre-step and never wakes an idle agent; disable it with `compactionNudge: false`.

## Limits

- **Same workspace only.** `grep_sessions` requires an exact `cwd` match and searches at most `maxSessions` sessions, newest first. It is not a global or cross-workspace index; use `dsh-experimental-session-search` for indexed full-text search across a workspace.
- **No trained recall policy.** The paper trains a model with RL to decide when to summarize and when to grep. That requires the GrepMem training stack and weights. This plugin supplies the inference-time capability, prompt triggers, and a post-compaction nudge, not the learned policy. A custom compaction backend or a trained checkpoint would be the next step.
- **Cold reads are bounded only by the process.** The worker deadline covers matching, not loading and folding a very large log. The LRU and `persistedCacheTtlMs` bound repeated work, not how long the first read takes.
- **Compaction is optional.** Recall works without it, but there is less discarded context to recover.
- **Regex is not RE2.** Patterns run in JavaScript. A pathological pattern blocks the Host for at most `fastTimeoutMs` before the worker fallback takes over; the worker's `timeoutMs` is the outer safety net.
- **Recall can echo prior answers.** Only grep tool results are skipped. If a previous answer, subagent report, or summary quoted a match, that text remains in the log and can match again. Use more specific patterns or a session scope when that noise matters.

## Development

The plugin has no runtime dependencies and no build step.

```bash
node --test
```

The suite covers grouping and headers, `count`, paging, invalid regex handling, compaction-summary labeling, grep-output exclusion, configured caps, multiline matching, incremental caching, workspace authorization, child-session filtering, and the worker deadline.

## Attribution

The design follows **“Forget Freely, Grep Later: Lossless, Index-Free Memory for Long-Horizon LLM Agents”** (Yang, Shi, and Zhao; arXiv:2611.25123) and the [GrepMem repository](https://github.com/limenlp/GrepMem), which is MIT-licensed. This is an independent DSH implementation: it reuses the paper's log-plus-grep design and paging/display conventions, not the repository's training or evaluation code.

## License

MIT.
