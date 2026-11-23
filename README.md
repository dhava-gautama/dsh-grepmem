# GrepMem history recall

A DeepSeek Harness plugin that adds **lossless, index-free recall over the current session's history**.

DSH already compacts long conversations: older messages are replaced on the model surface by a summary, while the original events stay in the append-only session log. This plugin adds the missing piece from [GrepMem](https://github.com/limenlp/GrepMem) — a `grep_history` tool that regex-searches that complete log, including the content compaction removed from context.

No embeddings, vector index, memory extraction, or extra model request. Nothing is written to the session; the log remains the only source of truth.

## Install

The bundle is installed through **Plugins** in DSH:

1. Open **Plugins → Add plugin**.
2. Choose the local directory containing this package.
3. Enable **GrepMem history recall** if it is not enabled automatically.

Installing adds the `grep_history` tool and a short system-prompt section to every agent in the profile. Turning the bundle off removes both.

## Use

The model calls the tool on its own when it needs a detail that is no longer in context:

```text
grep_history(pattern="budget-17", context_lines=2)
grep_history(pattern="ECONNREFUSED|timeout", max_matches=20, offset=0)
grep_history(pattern="api\\.example\\.com", count=true)
```

- `pattern` — case-insensitive JavaScript regular expression. Exact strings work best: names, numbers, IDs, paths, URLs, error text.
- `max_matches` — matching lines to show. Default 10.
- `offset` — skip matching lines; the footer reports the next offset.
- `context_lines` — lines around each match. Default 1, at most 3.
- `count` — return only the count of matching lines.

Results are grouped by the turn and tool call that produced them, with line numbers. Long lines are clipped for display; the stored history is unchanged. Earlier `grep_history` results are excluded so recall does not echo itself.

## Configuration

Set these in the profile's `cordis.patch.yml` under the `grepmem` row:

```yaml
- id: grepmem
  config:
    maxMatches: 20
    timeoutMs: 5000
```

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Register the tool and prompt section. |
| `maxMatches` | `10` | Default and per-call maximum matching lines (1–30). |
| `maxContextLines` | `3` | Maximum `context_lines` a call may request (0–3). |
| `lineChars` | `300` | Display width of one line before clipping around the match (80–2000). |
| `resultChars` | `6000` | Soft budget for one rendered page (500–40000). |
| `timeoutMs` | `10000` | Deadline for one search (1000–60000). |
| `includeReasoning` | `false` | Also search assistant reasoning blocks, when present. |

## How it works

1. `sessionQuery.readSession()` returns the replay-validated raw log of the calling session. It prefers the live session, so unflushed events are included.
2. Raw events are folded into entries: user messages, assistant replies, compaction summaries, and one entry per tool result paired with its call. Content that compaction shadowed stays available because the raw log is read, not the model surface.
3. A worker thread runs the regex over the entries. The Host terminates it at `timeoutMs`, so a pathological pattern cannot block DSH.
4. The page renderer labels each group with its turn/tool header, clips long lines around the match, and stops at `resultChars`.

## Limits

- Searches the calling session only. Cross-session recall is a separate capability (`dsh-experimental-session-search`).
- Regex is per line; patterns cannot span line boundaries.
- Each call reads the session log, so a very large session costs proportional read time. The worker deadline bounds matching, not log loading.
- Log entries that are not messages or tool results (headers, approvals, jobs, and other lifecycle events) are not searched.
- The plugin does not change compaction; it only makes the log recoverable. Compaction must be mounted (DSH's base profile mounts it by default).

## Attribution

The design follows **“Forget Freely, Grep Later: Lossless, Index-Free Memory for Long-Horizon LLM Agents”** (Yang, Shi, and Zhao; arXiv:2611.25123) and the [GrepMem repository](https://github.com/limenlp/GrepMem), which is MIT-licensed. This is an independent DSH implementation: it reuses the paper's log-plus-grep design and paging/display conventions, not the repository's training or evaluation code.

## License

MIT.
