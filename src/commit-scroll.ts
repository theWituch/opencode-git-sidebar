// Work in graphemes so combining marks and emoji sequences are never split.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function cells(grapheme: string): number {
  if (!grapheme || /^\p{Mark}+$/u.test(grapheme)) return 0
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme)) return 2
  const cp = grapheme.codePointAt(0) ?? 0
  return cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) ? 2 : 1
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

export function cellWidth(text: string): number {
  return graphemes(text).reduce((sum, part) => sum + cells(part), 0)
}

// Advance whole graphemes until the remaining suffix fits. This ensures the
// final frame shows the end without cutting a wide character in half.
export function scrollEnd(parts: string[], width: number): number {
  if (width <= 0) return 0
  let remaining = parts.reduce((sum, part) => sum + cells(part), 0)
  let index = 0
  while (remaining > width && index < parts.length) remaining -= cells(parts[index++]!)
  return index
}

// Clip at the right edge, never in the middle of a grapheme.
export function clip(parts: string[], width: number): string {
  let used = 0
  let result = ""
  for (const part of parts) {
    const size = cells(part)
    if (used + size > width) break
    used += size
    result += part
  }
  return result
}

export function safeCommitMessage(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
}
