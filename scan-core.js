/**
 * Pure regex scan shared by the in-process fast path and the worker fallback.
 *
 * This function must stay self-contained: the fast path embeds its source in a
 * `vm.Script` so it runs in a new context with an execution deadline.
 *
 * @param {ReadonlyArray<{ kind: string, lines: readonly string[], sessionId?: string }>} entries
 * @param {string} pattern
 * @param {number} offset
 * @param {number} limit
 * @param {boolean} countOnly
 * @param {boolean} multiline
 */
export function scanCore(entries, pattern, offset, limit, countOnly, multiline) {
  const regex = new RegExp(pattern, multiline ? 'gis' : 'i')
  let total = 0
  const page = []
  const hitEntries = new Set()
  const hitSessions = new Set()
  const byKind = Object.create(null)

  const record = (entryIndex, lineIndex, column) => {
    if (!countOnly && total >= offset && total < offset + limit) {
      page.push([entryIndex, lineIndex, column])
    }
    total += 1
    const entry = entries[entryIndex]
    hitEntries.add(entryIndex)
    hitSessions.add(entry.sessionId)
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
  }

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]

    if (multiline) {
      const text = entry.lines.join('\n')
      let scanned = 0
      let lineIndex = 0
      let lineStart = 0
      let match
      while ((match = regex.exec(text)) !== null) {
        while (scanned < match.index) {
          if (text.charCodeAt(scanned) === 10) {
            lineIndex += 1
            lineStart = scanned + 1
          }
          scanned += 1
        }
        record(entryIndex, lineIndex, match.index - lineStart)
        if (match[0].length === 0) {
          regex.lastIndex = match.index + 1
          if (regex.lastIndex > text.length) break
        }
      }
      continue
    }

    const lines = entry.lines
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const match = regex.exec(lines[lineIndex])
      if (match !== null) record(entryIndex, lineIndex, match.index)
    }
  }

  return {
    total,
    page,
    entryCount: hitEntries.size,
    sessionCount: hitSessions.size,
    byKind,
  }
}
