import { execFile } from "node:child_process"

export type GitStatus = {
  /** Branch name, or `null` when HEAD is detached. */
  branch: string | null
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  /** Paths added to the index, counted once even if edited again. */
  added: number
  /** Other changed tracked paths, excluding conflicts. */
  trackedChanged: number
  /**
   * Net added/removed lines of tracked files versus HEAD (index + worktree, untracked
   * ignored, binary files count as zero). `null` when the diff could not be computed.
   */
  lineChanges: { added: number; removed: number } | null
}

export type Commit = { hash: string; oid: string; subject: string; message: string }

export type GitSnapshot =
  | { kind: "ready"; status: GitStatus | null; commits: Commit[] }
  | { kind: "not-repo" | "unavailable" }

export type ReadGitOptions = { showStatus: boolean; commitCount: number }

const TIMEOUT_MS = 5000
const MAX_COMMITS = 100
const MAX_BUFFER = 64 * 1024 * 1024

type RunResult = { ok: true; stdout: string } | { ok: false; stderr: string; missing: boolean }

/** Runs git without a shell and without taking optional locks (read-only). */
function git(args: string[], cwd: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
        {
          cwd,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          signal,
          env: {
            ...process.env,
            LC_ALL: "C",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ ok: true, stdout: String(stdout) })
          const code = (error as NodeJS.ErrnoException).code
          resolve({ ok: false, stderr: String(stderr ?? ""), missing: code === "ENOENT" })
        },
      )
    } catch {
      resolve({ ok: false, stderr: "", missing: false })
    }
  })
}

/** Parses `git status --porcelain=v2 --branch -z` output. */
export function parseStatus(output: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    added: 0,
    trackedChanged: 0,
    lineChanges: null,
  }
  const tokens = output.split("\0")
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (!t) continue
    if (t.startsWith("# ")) {
      if (t.startsWith("# branch.head ")) {
        const head = t.slice("# branch.head ".length)
        status.branch = head === "(detached)" ? null : head
      } else if (t.startsWith("# branch.ab ")) {
        const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(t)
        if (m) {
          status.ahead = Number(m[1])
          status.behind = Number(m[2])
        }
      }
      continue
    }
    switch (t[0]) {
      case "1":
      case "2": {
        const x = t[2]
        const y = t[3]
        if (x && x !== ".") status.staged++
        if (y && y !== ".") status.unstaged++
        if (x === "A") status.added++
        else status.trackedChanged++
        // Renamed/copied entries are followed by an extra NUL-separated original path.
        if (t[0] === "2") i++
        break
      }
      case "u":
        status.conflicted++
        break
      case "?":
        status.untracked++
        break
      default:
        break // "!" ignored entries and unknown records
    }
  }
  return status
}

/** Parses `git diff --numstat -z` output into total added/removed lines (binary = 0). */
export function parseNumstat(output: string): { added: number; removed: number } {
  const total = { added: 0, removed: 0 }
  const tokens = output.split("\0")
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]!)
    if (!m) continue
    if (m[1] !== "-") total.added += Number(m[1])
    if (m[2] !== "-") total.removed += Number(m[2])
    // Renames/copies: empty path here, followed by source and destination paths.
    if (m[3] === "") i += 2
  }
  return total
}

const EMPTY_TREE: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
}

/** Net tracked line changes vs HEAD (or the empty tree on an unborn branch); null on any failure. */
async function readLineChanges(
  directory: string,
  unborn: boolean,
  signal?: AbortSignal,
): Promise<{ added: number; removed: number } | null> {
  let base = "HEAD"
  if (unborn) {
    const fmt = await git(["rev-parse", "--show-object-format"], directory, signal)
    const oid = fmt.ok ? EMPTY_TREE[fmt.stdout.trim()] : undefined
    if (!oid) return null
    base = oid
  }
  if (signal?.aborted) return null
  const res = await git(
    [
      "diff",
      base,
      "--numstat",
      "-z",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      "--find-renames",
      "--ignore-submodules=all",
      "--",
    ],
    directory,
    signal,
  )
  return res.ok ? parseNumstat(res.stdout) : null
}

/** Parses `git log -z --format=%h%n%H%n%B` output; `subject` is the first message line, `message` the full raw message. */
export function parseCommits(output: string): Commit[] {
  const commits: Commit[] = []
  for (const record of output.split("\0")) {
    const first = record.indexOf("\n")
    if (first <= 0) continue
    const second = record.indexOf("\n", first + 1)
    if (second <= first + 1) continue
    const message = record.slice(second + 1)
    const nextLine = message.indexOf("\n")
    const subject = (nextLine === -1 ? message : message.slice(0, nextLine)).replace(/\r$/, "")
    commits.push({
      hash: record.slice(0, first),
      oid: record.slice(first + 1, second),
      subject,
      message,
    })
  }
  return commits
}

export type CommitFile = { status: string; path: string; previousPath?: string }

export type CommitDetails = {
  authorName: string
  authorEmail: string
  /** Author date, strict ISO 8601. */
  authoredAt: string
  files: CommitFile[]
}

/** Parses `git diff-tree -r -z --name-status` output; renames/copies carry `previousPath`. */
export function parseNameStatus(output: string): CommitFile[] {
  const files: CommitFile[] = []
  const tokens = output.split("\0")
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]!
    if (!code) continue
    const status = code[0]!
    if (status === "R" || status === "C") {
      const previousPath = tokens[i + 1]
      const path = tokens[i + 2]
      i += 2
      if (previousPath === undefined || path === undefined) break
      files.push({ status, path, previousPath })
    } else {
      const path = tokens[++i]
      if (path === undefined) break
      files.push({ status, path })
    }
  }
  return files
}

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * Reads author metadata and changed files of one commit on demand. Merges are compared with
 * their first parent, root commits with the empty tree. Returns `null` on invalid input or failure.
 */
export async function readCommitDetails(
  directory: string,
  oid: string,
  signal?: AbortSignal,
): Promise<CommitDetails | null> {
  if (typeof oid !== "string" || !FULL_OID.test(oid)) return null
  const rev = `${oid}^{commit}`
  const [meta, parents] = await Promise.all([
    git(
      [
        "log",
        "-1",
        "--no-walk",
        "--no-mailmap",
        "--no-color",
        "--no-decorate",
        "--no-show-signature",
        "--no-notes",
        "--encoding=UTF-8",
        "--format=%an%x00%ae%x00%aI",
        rev,
        "--",
      ],
      directory,
      signal,
    ),
    git(["rev-list", "--parents", "-n1", rev, "--"], directory, signal),
  ])
  if (!meta.ok || !parents.ok) return null
  const [authorName, authorEmail, authoredAt] = meta.stdout.replace(/\r?\n$/, "").split("\0")
  if (authorName === undefined || authorEmail === undefined || !authoredAt) return null
  const ids = parents.stdout.trim().split(/\s+/)
  if (signal?.aborted) return null
  const target = ids[0]!
  const common = [
    "diff-tree",
    "-r",
    "-z",
    "--name-status",
    "--no-commit-id",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--ignore-submodules=none",
  ]
  const args = ids.length > 1 ? [...common, ids[1]!, target, "--"] : [...common, "--root", target, "--"]
  const diff = await git(args, directory, signal)
  if (!diff.ok) return null
  return { authorName, authorEmail, authoredAt, files: parseNameStatus(diff.stdout) }
}

export async function readGit(
  directory: string,
  options: ReadGitOptions,
  signal?: AbortSignal,
): Promise<GitSnapshot> {
  const count = Number.isFinite(options.commitCount)
    ? Math.min(Math.max(Math.floor(options.commitCount), 0), MAX_COMMITS)
    : 0
  if (!options.showStatus && count === 0) return { kind: "ready", status: null, commits: [] }

  const probe = await git(["rev-parse", "--is-inside-work-tree"], directory, signal)
  if (!probe.ok) {
    if (!probe.missing && /not a git repository/i.test(probe.stderr)) return { kind: "not-repo" }
    return { kind: "unavailable" }
  }
  if (probe.stdout.trim() !== "true") return { kind: "not-repo" } // bare repo or inside .git

  const [statusRes, logRes] = await Promise.all([
    options.showStatus
      ? git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"], directory, signal)
      : undefined,
    count > 0
      ? git(
          [
            "log",
            `-n${count}`,
            "--no-color",
            "--no-decorate",
            "--no-show-signature",
            "--no-notes",
            "--encoding=UTF-8",
            "--abbrev=7",
            "-z",
            "--format=%h%n%H%n%B",
          ],
          directory,
          signal,
        )
      : undefined,
  ])

  let status: GitStatus | null = null
  if (statusRes) {
    if (!statusRes.ok) return { kind: "unavailable" }
    status = parseStatus(statusRes.stdout)
    if (status.staged + status.unstaged + status.conflicted === 0) {
      status.lineChanges = { added: 0, removed: 0 }
    } else if (!signal?.aborted) {
      // Header records precede all path records, so only the leading part is inspected.
      const unborn = statusRes.stdout.startsWith("# branch.oid (initial)\0")
      status.lineChanges = await readLineChanges(directory, unborn, signal)
    }
  }

  let commits: Commit[] = []
  if (logRes) {
    if (logRes.ok) commits = parseCommits(logRes.stdout)
    else if (!/does not have any commits yet/i.test(logRes.stderr)) return { kind: "unavailable" }
  }

  return { kind: "ready", status, commits }
}
