/**
 * k6 script for `pnpm perf:fs`, `pnpm perf:pg` and `pnpm perf:remote`
 * (`perf-runner.ts`'s `k6Get`): unsigned GETs from VUS virtual users for
 * DURATION, counting any non-200 answer as a failure. TARGETS is a JSON array
 * of `{ path, backend? }`: successive requests, across every virtual user, go
 * to successive targets round-robin, each tagged with its target's backend. A
 * threshold that always passes on each backend's submetrics is what makes k6
 * put them in its summary. Writes k6's end-of-test summary to SUMMARY_PATH as
 * JSON, for the runner to read, and nothing to stdout.
 */
import http from 'k6/http'
import exec from 'k6/execution'
import { check } from 'k6'

const targets = JSON.parse(__ENV.TARGETS)
const backends = [
  ...new Set(targets.map(({ backend }) => backend).filter(Boolean))
]

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '20s',
  // Each body is still read in full, so the rate is unchanged; keeping them
  // ran k6 out of memory on a 512 MB machine reading the 10 MiB file.
  discardResponseBodies: true,
  thresholds: Object.fromEntries(
    backends.flatMap(backend => [
      [`http_reqs{backend:${backend}}`, ['count>=0']],
      [`http_req_duration{backend:${backend}}`, ['avg>=0']],
      [`checks{backend:${backend}}`, ['rate>=0']]
    ])
  )
}

export default function () {
  const { path, backend } =
    targets[exec.scenario.iterationInTest % targets.length]
  const tags = backend ? { backend } : {}
  const response = http.get(`${__ENV.BASE_URL}${path}`, { tags })
  check(response, { 'status is 200': res => res.status === 200 }, tags)
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_PATH]: JSON.stringify(data) }
}
