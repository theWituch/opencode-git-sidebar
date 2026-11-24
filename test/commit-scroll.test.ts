import { test } from "node:test"
import { strict as assert } from "node:assert"
import { cellWidth, clip, graphemes, safeCommitMessage, scrollEnd } from "../src/commit-scroll.ts"

test("fits subjects using terminal cells and stops at the last full grapheme", () => {
  assert.equal(scrollEnd(graphemes("hello"), 5), 0)
  assert.equal(scrollEnd(graphemes("hello"), 3), 2)
  assert.equal(scrollEnd(graphemes("a界b"), 3), 1)
  assert.equal(scrollEnd(graphemes("a界b"), 2), 2)
  assert.equal(scrollEnd(graphemes("hello"), 0), 0)
})

test("clips the moving subject at the right edge without a stationary suffix", () => {
  const parts = graphemes("abcdef")
  assert.equal(clip(parts, 4), "abcd")
  assert.equal(clip(parts.slice(1), 4), "bcde")
  assert.equal(clip(parts.slice(scrollEnd(parts, 4)), 4), "cdef")
  assert.equal(clip(graphemes("a界b"), 2), "a")
})

test("sanitizes terminal controls while preserving message layout", () => {
  assert.equal(safeCommitMessage("a\r\n\r\n  line\ttext\x1b[31m\u202eevil"), "a\n\n  line\ttext[31mevil")
})

test("combining sequences and emoji remain intact", () => {
  const parts = graphemes("e\u0301👩‍💻x")
  assert.deepEqual(parts, ["e\u0301", "👩‍💻", "x"])
  assert.equal(cellWidth(parts.join("")), 4)
  assert.equal(scrollEnd(parts, 3), 1)
  assert.equal(cellWidth("🇵🇱"), 2)
})
