/**
 * k6 script for `pnpm perf:fs` (scripts/performance/perf-fs.ts): unsigned GETs of one URL
 * from VUS virtual users for DURATION, counting any non-200 answer as a
 * failure. Writes k6's end-of-test summary to SUMMARY_PATH as JSON, for the
 * runner to read, and nothing to stdout.
 */
import http from 'k6/http'
import { check } from 'k6'

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '20s'
}

const url = `${__ENV.BASE_URL}${__ENV.TARGET_PATH}`

export default function () {
  const response = http.get(url)
  check(response, { 'status is 200': res => res.status === 200 })
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data) }
}
