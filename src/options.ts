const defaults = {
  showStatus: true,
  showCommits: true,
  scrollCommits: true,
  commitCount: 2,
  refreshIntervalMs: 10000,
}

function booleanOption(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function integerOption(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

export function resolveOptions(input: unknown) {
  const options = input && typeof input === "object" ? input as Record<string, unknown> : {}
  const placement = options.placement === "append" ? "append" : "prepend"
  return {
    showStatus: booleanOption(options.showStatus, defaults.showStatus),
    showCommits: booleanOption(options.showCommits, defaults.showCommits),
    scrollCommits: booleanOption(options.scrollCommits, defaults.scrollCommits),
    commitCount: integerOption(options.commitCount, defaults.commitCount, 0, 50),
    refreshIntervalMs: integerOption(options.refreshIntervalMs, defaults.refreshIntervalMs, 1000, 60000),
    placement,
  }
}
