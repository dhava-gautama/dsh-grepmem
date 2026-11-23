/**
 * Regex search over prepared history entries.
 *
 * Runs off the Host's main thread so the parent can terminate a pathological
 * pattern at its deadline. Only the requested page is returned; the total and
 * source counts are always complete.
 *
 * @module @local/dsh-grepmem/grep-worker
 */

import { parentPort, workerData } from 'node:worker_threads'

const { entries, pattern, offset, limit, countOnly } = workerData

let regex
try {
  regex = new RegExp(pattern, 'i')
} catch (error) {
  parentPort.postMessage({ error: `invalid regular expression: ${error?.message ?? String(error)}` })
}

if (regex !== undefined) {
  let total = 0
  const page = []
  const hitEntries = new Set()
  const byKind = Object.create(null)

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex]
    const lines = entry.lines
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const match = regex.exec(lines[lineIndex])
      if (match === null) continue
      if (!countOnly && total >= offset && total < offset + limit) {
        page.push([entryIndex, lineIndex, match.index])
      }
      total += 1
      hitEntries.add(entryIndex)
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
    }
  }

  parentPort.postMessage({
    total,
    page,
    entryCount: hitEntries.size,
    byKind,
  })
}
