import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveOptions } from "../src/options.ts"

test("defaults to both sections, two commits and ten seconds", () => {
  const expected = { showStatus: true, showCommits: true, scrollCommits: true, commitCount: 2, refreshIntervalMs: 10000, placement: "prepend" }
  assert.deepEqual(resolveOptions(undefined), expected)
  assert.deepEqual(resolveOptions({}), expected)
})

test("accepts independent visibility flags and numeric settings", () => {
  assert.deepEqual(resolveOptions({
    showStatus: false,
    showCommits: false,
    commitCount: 0,
    refreshIntervalMs: 1200,
    placement: "append",
  }), { showStatus: false, showCommits: false, scrollCommits: true, commitCount: 0, refreshIntervalMs: 1200, placement: "append" })
})

test("accepts disabled scrolling without hiding commits", () => {
  const options = resolveOptions({ scrollCommits: false })
  assert.equal(options.scrollCommits, false)
  assert.equal(options.showCommits, true)
})

test("accepts prepend and falls back to it for unsupported placements", () => {
  assert.equal(resolveOptions({ placement: "prepend" }).placement, "prepend")
  assert.equal(resolveOptions({ placement: "bottom" }).placement, "prepend")
  assert.equal(resolveOptions({ placement: null }).placement, "prepend")
})

test("uses defaults for malformed values and limits numeric settings", () => {
  assert.deepEqual(resolveOptions({
    showStatus: "false",
    showCommits: 0,
    scrollCommits: "false",
    commitCount: 1.5,
    refreshIntervalMs: Infinity,
  }), resolveOptions(null))
  assert.equal(resolveOptions({ commitCount: -1 }).commitCount, 0)
  assert.equal(resolveOptions({ commitCount: 100 }).commitCount, 50)
  assert.equal(resolveOptions({ refreshIntervalMs: 1 }).refreshIntervalMs, 1000)
  assert.equal(resolveOptions({ refreshIntervalMs: 90000 }).refreshIntervalMs, 60000)
})
