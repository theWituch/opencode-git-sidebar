import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { parseCommits, parseNameStatus, readCommitDetails, readGit } from "../src/git.ts"
import type { GitSnapshot, GitStatus } from "../src/git.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "oc-git-test-")))
const saved = { ...process.env }

// Isolate from the user's Git config/identity and never discover repos above the temp root.
process.env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"
process.env.GIT_CEILING_DIRECTORIES = root
process.env.GIT_AUTHOR_NAME = "Test"
process.env.GIT_AUTHOR_EMAIL = "test@example.invalid"
process.env.GIT_COMMITTER_NAME = "Test"
process.env.GIT_COMMITTER_EMAIL = "test@example.invalid"

let counter = 0
function dir(name: string): string {
  const d = join(root, `${name}-${counter++}`)
  mkdirSync(d, { recursive: true })
  return d
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: "pipe" })
}

function write(cwd: string, file: string, content = "x\n") {
  writeFileSync(join(cwd, file), content)
}

function init(name: string): string {
  const d = dir(name)
  git(d, "init", "-q")
  git(d, "symbolic-ref", "HEAD", "refs/heads/main")
  return d
}

function commit(cwd: string, file: string, message: string, content = `${message}\n`) {
  write(cwd, file, content)
  git(cwd, "add", "--", file)
  git(cwd, "commit", "-q", "-m", message)
}

function ready(s: GitSnapshot) {
  assert.equal(s.kind, "ready")
  return s as Extract<GitSnapshot, { kind: "ready" }>
}

function status(s: GitSnapshot): GitStatus {
  const r = ready(s)
  assert.ok(r.status)
  return r.status
}

const both = { showStatus: true, commitCount: 3 }

before(() => {
  // sanity: git must be present for these tests
  git(root, "--version")
})

after(() => {
  process.env = saved
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe("readGit", () => {
  test("hidden status and zero commits return early without touching git", async () => {
    const d = dir("plain") // not a repo, still ready
    const s = await readGit(d, { showStatus: false, commitCount: 0 })
    assert.deepEqual(s, { kind: "ready", status: null, commits: [] })
  })

  test("reports not-repo outside a repository", async () => {
    assert.deepEqual(await readGit(dir("plain"), both), { kind: "not-repo" })
    assert.deepEqual(await readGit(dir("plain"), { showStatus: false, commitCount: 2 }), { kind: "not-repo" })
  })

  test("reports not-repo inside a .git directory", async () => {
    const d = init("gitdir")
    assert.deepEqual(await readGit(join(d, ".git"), both), { kind: "not-repo" })
  })

  test("reports unavailable when git is missing", async () => {
    const d = init("nogit")
    const path = process.env.PATH
    process.env.PATH = ""
    try {
      assert.deepEqual(await readGit(d, both), { kind: "unavailable" })
    } finally {
      process.env.PATH = path
    }
  })

  test("reports unavailable when aborted", async () => {
    const d = init("abort")
    const ac = new AbortController()
    ac.abort()
    assert.deepEqual(await readGit(d, both, ac.signal), { kind: "unavailable" })
  })

  test("clean repo with commits", async () => {
    const d = init("clean")
    commit(d, "a.txt", "first")
    commit(d, "b.txt", "second")
    const r = ready(await readGit(d, both))
    assert.deepEqual(r.status, {
      branch: "main",
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      added: 0,
      trackedChanged: 0,
      lineChanges: { added: 0, removed: 0 },
    })
    assert.deepEqual(
      r.commits.map((c) => c.subject),
      ["second", "first"],
    )
    for (const c of r.commits) assert.match(c.hash, /^[0-9a-f]{7,}$/)
  })

  test("limits commits to the requested count and skips log at zero", async () => {
    const d = init("count")
    for (const n of ["c1", "c2", "c3", "c4", "c5"]) commit(d, `${n}.txt`, n)
    const five = ready(await readGit(d, { showStatus: false, commitCount: 5 }))
    assert.equal(five.status, null)
    assert.deepEqual(
      five.commits.map((c) => c.subject),
      ["c5", "c4", "c3", "c2", "c1"],
    )
    assert.equal(ready(await readGit(d, { showStatus: false, commitCount: 2 })).commits.length, 2)
    const none = ready(await readGit(d, { showStatus: true, commitCount: 0 }))
    assert.deepEqual(none.commits, [])
    assert.ok(none.status)
    assert.equal(ready(await readGit(d, { showStatus: false, commitCount: -4 })).commits.length, 0)
    assert.equal(ready(await readGit(d, { showStatus: false, commitCount: 2.9 })).commits.length, 2)
  })

  test("keeps subjects with tabs and unicode on one record", async () => {
    const d = init("subject")
    commit(d, "a.txt", "feat:\tzażółć gęślą jaźń")
    const r = ready(await readGit(d, { showStatus: false, commitCount: 1 }))
    assert.equal(r.commits[0]!.subject, "feat:\tzażółć gęślą jaźń")
  })

  test("ignores user abbrev and log output encoding config", async () => {
    const d = init("config")
    commit(d, "a.txt", "zażółć gęślą jaźń")
    git(d, "config", "core.abbrev", "40")
    git(d, "config", "i18n.logOutputEncoding", "ISO-8859-2")
    const r = ready(await readGit(d, { showStatus: false, commitCount: 1 }))
    assert.equal(r.commits[0]!.hash.length, 7)
    assert.equal(r.commits[0]!.subject, "zażółć gęślą jaźń")
  })

  test("keeps only the first line of each commit message", async () => {
    const d = init("multiline")
    commit(d, "a.txt", "line one\nline two\n\nbody")
    commit(d, "b.txt", "second")
    const r = ready(await readGit(d, { showStatus: false, commitCount: 2 }))
    assert.deepEqual(
      r.commits.map((c) => c.subject),
      ["second", "line one"],
    )
  })

  test("counts staged, unstaged, untracked with odd filenames", async () => {
    const d = init("dirty")
    commit(d, "tracked.txt", "base")
    commit(d, "other.txt", "base2")
    write(d, "staged file.txt")
    git(d, "add", "--", "staged file.txt")
    write(d, "tracked.txt", "changed\n")
    write(d, "zażółć ł.txt")
    write(d, "with space.txt")
    const s = status(await readGit(d, both))
    assert.equal(s.staged, 1)
    assert.equal(s.unstaged, 1)
    assert.equal(s.untracked, 2)
    assert.equal(s.conflicted, 0)
    assert.equal(s.added, 1)
    assert.equal(s.trackedChanged, 1)
  })

  test("line changes are net vs HEAD across index and worktree", async () => {
    const d = init("lines")
    commit(d, "a.txt", "base", "1\n2\n3\n4\n")
    commit(d, "b.txt", "base2", "x\ny\n")
    write(d, "a.txt", "1\n2\n3\n4\n5\n6\n") // +2 staged
    git(d, "add", "--", "a.txt")
    write(d, "a.txt", "1\n2\n3\n4\n5\n") // net +1 vs HEAD
    write(d, "b.txt", "x\n") // -1 unstaged
    write(d, "untracked.txt", "u1\nu2\nu3\n") // ignored
    writeFileSync(join(d, "bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0]))
    git(d, "add", "--", "bin.dat") // binary contributes zero
    const s = status(await readGit(d, both))
    assert.deepEqual(s.lineChanges, { added: 1, removed: 1 })
    assert.equal(s.untracked, 1)
  })

  test("line changes with rename followed by other entries", async () => {
    const d = init("lines-rename")
    commit(d, "old.txt", "base", "a\nb\nc\nd\ne\nf\ng\nh\n")
    commit(d, "z.txt", "base2", "1\n")
    git(d, "mv", "old.txt", "new.txt")
    write(d, "z.txt", "1\n2\n3\n")
    const s = status(await readGit(d, both))
    assert.deepEqual(s.lineChanges, { added: 2, removed: 0 })
  })

  test("line changes on an unborn branch count staged files against the empty tree", async () => {
    const d = init("lines-unborn")
    write(d, "a.txt", "1\n2\n3\n")
    git(d, "add", "--", "a.txt")
    write(d, "u.txt", "ignored\n")
    const s = status(await readGit(d, both))
    assert.deepEqual(s.lineChanges, { added: 3, removed: 0 })
  })

  test("line changes on an unborn sha256 repository", async (t) => {
    const d = dir("lines-sha256")
    try {
      git(d, "init", "-q", "--object-format=sha256")
    } catch {
      t.skip("git lacks sha256 support")
      return
    }
    git(d, "symbolic-ref", "HEAD", "refs/heads/main")
    write(d, "a.txt", "1\n2\n")
    git(d, "add", "--", "a.txt")
    const s = status(await readGit(d, both))
    assert.deepEqual(s.lineChanges, { added: 2, removed: 0 })
  })

  test("counts a file changed in index and worktree on both sides", async () => {
    const d = init("both")
    commit(d, "a.txt", "base")
    write(d, "a.txt", "one\n")
    git(d, "add", "--", "a.txt")
    write(d, "a.txt", "two\n")
    const s = status(await readGit(d, both))
    assert.equal(s.staged, 1)
    assert.equal(s.unstaged, 1)
    assert.equal(s.trackedChanged, 1)
  })

  test("counts an index addition edited in the worktree once, as added", async () => {
    const d = init("added")
    write(d, "new.txt", "initial\n")
    git(d, "add", "--", "new.txt")
    write(d, "new.txt", "changed after staging\n")
    const s = status(await readGit(d, both))
    assert.equal(s.staged, 1)
    assert.equal(s.unstaged, 1)
    assert.equal(s.added, 1)
    assert.equal(s.trackedChanged, 0)
  })

  test("handles renames followed by other entries", async () => {
    const d = init("rename")
    commit(d, "old name.txt", "base", "some content that is long enough\nfor rename detection\n")
    git(d, "mv", "old name.txt", "new name.txt")
    write(d, "after.txt")
    const s = status(await readGit(d, both))
    assert.equal(s.staged, 1)
    assert.equal(s.untracked, 1)
    assert.equal(s.unstaged, 0)
    assert.equal(s.added, 0)
    assert.equal(s.trackedChanged, 1)
  })

  test("counts merge conflicts", async () => {
    const d = init("conflict")
    commit(d, "a.txt", "base")
    git(d, "checkout", "-q", "-b", "feature")
    commit(d, "a.txt", "feature change")
    git(d, "checkout", "-q", "main")
    commit(d, "a.txt", "main change")
    assert.throws(() => git(d, "merge", "feature"))
    const s = status(await readGit(d, both))
    assert.equal(s.conflicted, 1)
    assert.equal(s.trackedChanged, 0)
  })

  test("works from nested subdirectories", async () => {
    const d = init("nested")
    commit(d, "a.txt", "first")
    const sub = join(d, "x", "y")
    mkdirSync(sub, { recursive: true })
    write(sub, "n.txt")
    const r = ready(await readGit(sub, both))
    assert.equal(r.status?.branch, "main")
    assert.equal(r.status?.untracked, 1)
    assert.equal(r.commits.length, 1)
  })

  test("detached HEAD has null branch", async () => {
    const d = init("detached")
    commit(d, "a.txt", "first")
    commit(d, "b.txt", "second")
    git(d, "checkout", "-q", "--detach", "HEAD~1")
    const r = ready(await readGit(d, both))
    assert.equal(r.status?.branch, null)
    assert.deepEqual(
      r.commits.map((c) => c.subject),
      ["first"],
    )
  })

  test("unborn branch has name and no commits", async () => {
    const d = init("unborn")
    write(d, "a.txt")
    const r = ready(await readGit(d, both))
    assert.equal(r.status?.branch, "main")
    assert.equal(r.status?.untracked, 1)
    assert.deepEqual(r.commits, [])
    const logOnly = ready(await readGit(d, { showStatus: false, commitCount: 3 }))
    assert.deepEqual(logOnly, { kind: "ready", status: null, commits: [] })
  })

  test("linked worktree reports its own branch", async () => {
    const d = init("wt-main")
    commit(d, "a.txt", "first")
    const wt = join(root, `wt-linked-${counter++}`)
    git(d, "worktree", "add", "-q", "-b", "wt-branch", wt)
    write(wt, "new.txt")
    const r = ready(await readGit(wt, both))
    assert.equal(r.status?.branch, "wt-branch")
    assert.equal(r.status?.untracked, 1)
    assert.equal(r.commits[0]!.subject, "first")
    assert.equal(status(await readGit(d, both)).branch, "main")
  })

  test("reports ahead/behind against a local upstream", async () => {
    const d = init("ahead")
    commit(d, "a.txt", "first")
    const bare = dir("bare")
    git(bare, "init", "-q", "--bare")
    git(d, "remote", "add", "origin", bare)
    git(d, "push", "-q", "-u", "origin", "main")
    commit(d, "b.txt", "local")
    const s = status(await readGit(d, both))
    assert.equal(s.ahead, 1)
    assert.equal(s.behind, 0)
  })

  test("does not create files in the repository (read-only)", async () => {
    const d = init("ro")
    commit(d, "a.txt", "first")
    const before = git(d, "ls-files", "-s")
    await readGit(d, both)
    assert.equal(git(d, "ls-files", "-s"), before)
  })
})

describe("commit messages in snapshot", () => {
  test("readGit exposes full multiline message alongside subject", async () => {
    const d = init("message")
    commit(d, "a.txt", "first")
    write(d, "b.txt", "hello\n")
    git(d, "add", "--", "b.txt")
    git(d, "commit", "-q", "-m", "subject line", "-m", "body line one\nbody line two")
    git(d, "notes", "add", "-m", "a note")
    const r = ready(await readGit(d, { showStatus: false, commitCount: 5 }))
    assert.equal(r.commits.length, 2)
    assert.equal(r.commits[0]!.subject, "subject line")
    assert.equal(r.commits[0]!.message, "subject line\n\nbody line one\nbody line two\n")
    assert.equal(r.commits[1]!.subject, "first")
    assert.equal(r.commits[1]!.message, "first\n")
  })

  test("merge commit carries only its own message", async () => {
    const d = init("message-merge")
    commit(d, "a.txt", "base")
    git(d, "checkout", "-q", "-b", "side")
    commit(d, "side.txt", "side")
    git(d, "checkout", "-q", "main")
    commit(d, "main.txt", "mainline")
    git(d, "merge", "-q", "--no-ff", "-m", "merge side", "side")
    const r = ready(await readGit(d, { showStatus: false, commitCount: 1 }))
    assert.equal(r.commits[0]!.message, "merge side\n")
  })

  test("parseCommits splits NUL records and keeps subject semantics", () => {
    const out = parseCommits("abc1234\nabc1234ffff\nfirst\r\n\nbody\n\0def5678\ndef5678ffff\nsecond\n")
    assert.deepEqual(out, [
      { hash: "abc1234", oid: "abc1234ffff", subject: "first", message: "first\r\n\nbody\n" },
      { hash: "def5678", oid: "def5678ffff", subject: "second", message: "second\n" },
    ])
    assert.deepEqual(parseCommits(""), [])
  })
})

describe("readCommitDetails", () => {
  async function top(d: string) {
    const r = ready(await readGit(d, { showStatus: false, commitCount: 1 }))
    return r.commits[0]!
  }

  /** Repo whose top commit renames, adds and deletes a file. */
  function renameFixture(name: string): string {
    const d = init(name)
    commit(d, "old name.txt", "base", "some content that is long enough\nfor rename detection\n")
    commit(d, "gone.txt", "other")
    git(d, "mv", "old name.txt", "zażółć.txt")
    git(d, "rm", "-q", "--", "gone.txt")
    write(d, "added.txt")
    git(d, "add", "--", "added.txt")
    git(d, "commit", "-q", "-m", "change")
    return d
  }

  const renameFiles = [
    { status: "A", path: "added.txt" },
    { status: "D", path: "gone.txt" },
    { status: "R", path: "zażółć.txt", previousPath: "old name.txt" },
  ]
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)

  test("forces rename detection and ignores log/diff config, notes and worktree changes", async () => {
    const d = renameFixture("details-config")
    const c = await top(d)
    git(d, "notes", "add", "-m", "a note")
    git(d, "config", "diff.renames", "false")
    git(d, "config", "core.quotePath", "true")
    git(d, "config", "log.showSignature", "true")
    git(d, "config", "log.mailmap", "true")
    git(d, "config", "gpg.program", "false")
    write(d, "added.txt", "dirty\n")
    write(d, "untracked.txt")
    const det = await readCommitDetails(d, c.oid)
    assert.ok(det)
    assert.equal(det.authorName, "Test")
    assert.equal(det.authorEmail, "test@example.invalid")
    assert.deepEqual([...det.files].sort(byPath), renameFiles)
  })

  test("exposes full oid and returns metadata with renames, adds, deletes", async () => {
    const d = renameFixture("details")
    const c = await top(d)
    assert.match(c.oid, /^[0-9a-f]{40,64}$/)
    assert.ok(c.oid.startsWith(c.hash))
    const det = await readCommitDetails(d, c.oid)
    assert.ok(det)
    assert.equal(det.authorName, "Test")
    assert.equal(det.authorEmail, "test@example.invalid")
    assert.ok(!Number.isNaN(Date.parse(det.authoredAt)))
    assert.deepEqual([...det.files].sort(byPath), renameFiles)
  })

  test("a path named like the revision does not confuse git", async () => {
    const d = init("details-ambiguous")
    commit(d, "a.txt", "first")
    const c = await top(d)
    commit(d, c.oid, "same name as the oid")
    const det = await readCommitDetails(d, c.oid)
    assert.deepEqual(det?.files, [{ status: "A", path: "a.txt" }])
  })

  test("root commit lists its files", async () => {
    const d = init("details-root")
    commit(d, "a.txt", "first")
    const det = await readCommitDetails(d, (await top(d)).oid)
    assert.deepEqual(det?.files, [{ status: "A", path: "a.txt" }])
  })

  test("empty commit has no files", async () => {
    const d = init("details-empty")
    commit(d, "a.txt", "first")
    git(d, "commit", "-q", "--allow-empty", "-m", "empty")
    const det = await readCommitDetails(d, (await top(d)).oid)
    assert.ok(det)
    assert.deepEqual(det.files, [])
  })

  test("merge is compared with its first parent", async () => {
    const d = init("details-merge")
    commit(d, "a.txt", "base")
    git(d, "checkout", "-q", "-b", "side")
    commit(d, "side.txt", "side")
    git(d, "checkout", "-q", "main")
    commit(d, "main.txt", "mainline")
    git(d, "merge", "-q", "--no-ff", "-m", "merge side", "side")
    const det = await readCommitDetails(d, (await top(d)).oid)
    assert.deepEqual(det?.files, [{ status: "A", path: "side.txt" }])
  })

  test("rejects abbreviated, malformed, unknown and aborted requests", async () => {
    const d = init("details-invalid")
    commit(d, "a.txt", "first")
    const c = await top(d)
    assert.equal(await readCommitDetails(d, c.hash), null)
    assert.equal(await readCommitDetails(d, "--output=x"), null)
    assert.equal(await readCommitDetails(d, "HEAD"), null)
    assert.equal(await readCommitDetails(d, "0".repeat(40)), null)
    const ac = new AbortController()
    ac.abort()
    assert.equal(await readCommitDetails(d, c.oid, ac.signal), null)
    assert.equal(await readCommitDetails(dir("plain"), c.oid), null)
  })

  test("parseNameStatus handles renames and copies", () => {
    assert.deepEqual(parseNameStatus("R087\0a\0b\0M\0c\0C100\0d\0e\0"), [
      { status: "R", path: "b", previousPath: "a" },
      { status: "M", path: "c" },
      { status: "C", path: "e", previousPath: "d" },
    ])
  })
})
