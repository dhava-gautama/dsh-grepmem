/**
 * Worker fallback for searches that exceed the in-process fast-path deadline.
 *
 * The worker owns no state; it scans the entries sent with the request and
 * returns only the page, counts, and source totals. The Host terminates it at
 * `timeoutMs`, so a pathological pattern cannot block the process.
 *
 * @module @local/dsh-grepmem/grep-worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { scanCore } from './scan-core.js'

const { entries, pattern, offset, limit, countOnly, multiline } = workerData

try {
  parentPort.postMessage(scanCore(entries, pattern, offset, limit, countOnly, multiline))
} catch (error) {
  parentPort.postMessage({ error: `invalid regular expression: ${error?.message ?? String(error)}` })
}
