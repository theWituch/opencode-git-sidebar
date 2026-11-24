import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { isAbsolute } from "node:path"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { cellWidth, clip, graphemes, safeCommitMessage, scrollEnd } from "./commit-scroll.ts"
import { readCommitDetails, readGit, type Commit, type CommitDetails, type GitSnapshot } from "./git.ts"
import { resolveOptions } from "./options.ts"

// Repository text is untrusted terminal input. In particular, never let an
// embedded newline, escape sequence or bidirectional control alter the UI.
function safeText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
}

// Quote paths so leading/trailing spaces remain visible; escape terminal and
// direction controls without collapsing meaningful whitespace.
function safePath(value: string): string {
  return JSON.stringify(value).replace(/[\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

type Options = ReturnType<typeof resolveOptions>

function CommitRow(props: { hash: string; subject: string; offset: number; register: (hash: string, measure: () => void) => () => void; measure: (hash: string, end: number) => void; select: () => void; color: RGBA; hashColor: RGBA }) {
  let row: BoxRenderable | undefined
  const [width, setWidth] = createSignal(0)
  const hash = () => safeText(props.hash)
  const subject = () => safeText(props.subject.split(/\r?\n/, 1)[0] ?? "")
  const parts = createMemo(() => graphemes(subject()))
  const end = createMemo(() => scrollEnd(parts(), Math.max(0, width() - cellWidth(hash()) - 1)))

  createEffect(() => {
    if (!row) return
    const element = row
    const unregister = props.register(props.hash, () => {
      if (!element.isDestroyed) setWidth(element.getLayout().width)
    })
    onCleanup(unregister)
  })

  createEffect(() => props.measure(props.hash, end()))

  return (
    // Open on release so that the opening click cannot also dismiss the backdrop.
    <box ref={row} width="100%" onMouseUp={(event) => {
      if (event.button === 0) props.select()
    }}>
      <text fg={props.color} wrapMode="none" selectable={false}>
        <span style={{ fg: props.hashColor }}>{hash()}</span>
        {` ${clip(parts().slice(props.offset), Math.max(0, width() - cellWidth(hash()) - 1))}`}
      </text>
    </box>
  )
}

function GitSidebar(props: { context: Context; sessionID: string; options: Options }) {
  const [snapshot, setSnapshot] = createSignal<GitSnapshot | undefined>()
  const [expanded, setExpanded] = createSignal(true)
  const [ends, setEnds] = createSignal<Record<string, number>>({})
  const [active, setActive] = createSignal<string>()
  const [offset, setOffset] = createSignal(0)
  const [dialogOpen, setDialogOpen] = createSignal(false)
  let detailController: AbortController | undefined
  onCleanup(() => detailController?.abort())
  const theme = props.context.theme
  const measuredRows = new Map<string, () => void>()
  const register = (hash: string, measure: () => void) => {
    measuredRows.set(hash, measure)
    measure()
    return () => {
      if (measuredRows.get(hash) !== measure) return
      measuredRows.delete(hash)
      setEnds((previous) => {
        if (!(hash in previous)) return previous
        const next = { ...previous }
        delete next[hash]
        return next
      })
    }
  }
  createEffect(() => {
    if (!expanded()) return
    // Native scene boxes do not emit "resized". One listener measures all
    // mounted rows after layout, rather than registering one per commit.
    const measureRows = () => {
      for (const measure of measuredRows.values()) measure()
    }
    props.context.renderer.on("frame", measureRows)
    onCleanup(() => props.context.renderer.off("frame", measureRows))
  })

  createEffect(() => {
    // A session may point to a different worktree from the TUI's initial
    // location. Wait for its metadata rather than using an unrelated cwd.
    const directory = props.context.data.session.get(props.sessionID)?.location.directory
    setSnapshot(undefined)
    if (!directory || !isAbsolute(directory)) return

    let disposed = false
    let running = false
    let controller: AbortController | undefined
    const refresh = async () => {
      if (disposed || running) return
      running = true
      controller = new AbortController()
      try {
        const next = await readGit(directory, {
          showStatus: props.options.showStatus,
          commitCount: props.options.showCommits ? props.options.commitCount : 0,
        }, controller.signal)
        if (!disposed) {
          const previous = snapshot()
          if (next.kind === "ready" && previous?.kind === "ready") {
            next.commits = next.commits.map((commit) =>
              previous.commits.find((old) => old.oid === commit.oid && old.hash === commit.hash && old.subject === commit.subject && old.message === commit.message) ?? commit)
          }
          setSnapshot(next)
        }
      } catch {
        if (!disposed) setSnapshot({ kind: "unavailable" })
      } finally {
        running = false
      }
    }
    void refresh()
    const timer = setInterval(refresh, props.options.refreshIntervalMs)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      controller?.abort()
    })
  })

  const showCommits = props.options.showCommits && props.options.commitCount > 0
  const commits = () => {
    const current = snapshot()
    return current?.kind === "ready" ? current.commits : []
  }
  const eligible = createMemo(() => props.options.scrollCommits && expanded() && !dialogOpen()
    ? commits().filter((commit) => (ends()[commit.hash] ?? 0) > 0).map((commit) => `${commit.hash}:${ends()[commit.hash]}`).join(",")
    : "")
  const forwardStepMs = 125
  const backwardStepMs = 30
  const pauseMs = 2000
  createEffect(() => {
    const entries = eligible().split(",").filter(Boolean).map((entry) => {
      const index = entry.lastIndexOf(":")
      return { hash: entry.slice(0, index), end: Number(entry.slice(index + 1)) }
    })
    setActive(undefined)
    setOffset(0)
    if (!entries.length) return
    let timer: ReturnType<typeof setTimeout>
    let index = 0
    const start = () => {
      const item = entries[index]!
      setActive(item.hash)
      setOffset(0)
      const backward = () => {
        if (setOffset((current) => current - 1) > 0) timer = setTimeout(backward, backwardStepMs)
        else {
          setActive(undefined)
          index = (index + 1) % entries.length
          timer = setTimeout(start, entries.length === 1 ? 5000 : 180)
        }
      }
      const forward = () => {
        if (setOffset((current) => current + 1) < item.end) timer = setTimeout(forward, forwardStepMs)
        else timer = setTimeout(backward, pauseMs)
      }
      timer = setTimeout(forward, forwardStepMs)
    }
    timer = setTimeout(start, 5000)
    onCleanup(() => clearTimeout(timer))
  })
  const measure = (hash: string, end: number) => setEnds((previous) =>
    (previous[hash] ?? 0) === end ? previous : { ...previous, [hash]: end })
  const showCommit = (commit: Commit) => {
    const message = safeCommitMessage(commit.message)
    detailController?.abort()
    const controller = new AbortController()
    detailController = controller
    const [details, setDetails] = createSignal<CommitDetails | null>()
    const directory = props.context.data.session.get(props.sessionID)?.location.directory
    setDialogOpen(true)
    props.context.ui.dialog.set({ size: "large" })
    props.context.ui.dialog.show(() => (
      <box flexDirection="column" padding={1} gap={1}>
        <text fg={theme.text.base}><b>Commit details</b></text>
        <scrollbox height={20} focused>
          <box flexDirection="column" gap={1}>
            <text fg={theme.syntax.number}>{safeText(commit.oid)}</text>
            <Show when={details() === undefined}>
              <text fg={theme.text.muted}>Loading commit details…</text>
            </Show>
            <Show when={details() === null}>
              <text fg={theme.text.feedback.error.base}>Could not load commit details.</text>
            </Show>
            <Show when={details()}>{(detail: () => CommitDetails) =>
              <box flexDirection="column">
                <text fg={theme.text.base}>{`Author: ${safeText(detail().authorName)} <${safeText(detail().authorEmail)}>`}</text>
                <text fg={theme.text.muted}>{`Date: ${safeText(detail().authoredAt)}`}</text>
              </box>
            }</Show>
            <box flexDirection="column">
              <text fg={theme.text.muted}><b>Message</b></text>
              <text fg={theme.text.base}>{message || "(empty message)"}</text>
            </box>
            <box flexDirection="column">
              <text fg={theme.text.muted}><b>Changed files</b></text>
              <Show when={details()}>{(detail: () => CommitDetails) =>
                <Show when={detail().files.length > 0} fallback={<text fg={theme.text.muted}>No changed files</text>}>
                  <For each={detail().files}>{(file) =>
                    <text fg={theme.text.base}>{`${safeText(file.status)}  ${file.previousPath !== undefined ? `${safePath(file.previousPath)} → ` : ""}${safePath(file.path)}`}</text>
                  }</For>
                </Show>
              }</Show>
            </box>
          </box>
        </scrollbox>
        <text fg={theme.text.muted}>Esc to close · Scroll to see more</text>
      </box>
    ), () => {
      controller.abort()
      if (detailController === controller) {
        detailController = undefined
        setDialogOpen(false)
      }
    })
    if (!directory || !isAbsolute(directory)) {
      setDetails(null)
      return
    }
    void readCommitDetails(directory, commit.oid, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setDetails(result) })
      .catch(() => { if (!controller.signal.aborted) setDetails(null) })
  }
  const headerStatus = createMemo(() => {
    const current = snapshot()
    if (current?.kind === "unavailable") return [{ text: "unavailable", color: theme.text.muted }]
    if (current?.kind !== "ready") return []
    const s = current.status
    if (!props.options.showStatus || !s) return []
    const items = [
      { count: s.added, text: `+${s.added}`, color: theme.text.feedback.success.base },
      { count: s.trackedChanged, text: `±${s.trackedChanged}`, color: theme.text.feedback.warning.base },
      { count: s.untracked, text: `?${s.untracked}`, color: theme.text.feedback.info.base },
      { count: s.staged, text: `S${s.staged}`, color: theme.syntax.keyword },
    ].filter((item) => item.count > 0).map(({ text, color }) => ({ text, color }))
    if (s.conflicted > 0) {
      items.unshift({ text: `!${s.conflicted}`, color: theme.text.feedback.error.base })
    } else if (!(s.staged || s.unstaged || s.untracked)) {
      items.unshift({ text: "Clean", color: theme.text.muted })
    }
    if (s.ahead > 0 || s.behind > 0) {
      items.push({ text: `↑${s.ahead}`, color: theme.syntax.function })
      items.push({ text: `↓${s.behind}`, color: theme.syntax.function })
    }
    if (s.lineChanges?.added) {
      items.push({ text: `+${s.lineChanges.added}L`, color: theme.text.feedback.success.base })
    }
    if (s.lineChanges?.removed) {
      items.push({ text: `-${s.lineChanges.removed}L`, color: theme.diff.text.removed })
    }
    return items
  })
  return (
    <Show when={snapshot() && snapshot()?.kind !== "not-repo"}>
      <box flexDirection="column" marginTop={1}>
        <box flexDirection="row" gap={1} onMouseDown={(event) => {
          if (event.button === 0) setExpanded((value) => !value)
        }}>
          <text fg={theme.text.base} flexShrink={0}>{expanded() ? "▼" : "▶"}</text>
          <text fg={theme.text.base} flexShrink={0}><b>Git</b></text>
          <Show when={headerStatus().length > 0}>
            <text fg={theme.text.muted} wrapMode="none" truncate>
              <For each={headerStatus()}>{(item, index) =>
                <span style={{ fg: item.color }}>{`${index() ? " " : ""}${item.text}`}</span>
              }</For>
            </text>
          </Show>
        </box>
        <Show when={expanded() && showCommits && snapshot()?.kind === "ready"}>
          <For each={commits()} fallback={<text fg={theme.text.muted}>No commits</text>}>{(commit) =>
            <CommitRow hash={commit.hash} subject={commit.subject} color={theme.text.base} hashColor={theme.syntax.number}
              offset={active() === commit.hash ? offset() : 0} measure={measure} register={register}
              select={() => showCommit(commit)} />
          }</For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-git-sidebar",
  setup(context) {
    const options = resolveOptions(context.options)
    if (!options.showStatus && (!options.showCommits || options.commitCount === 0)) return
    const render = (slot: { sessionID: string }) => (
      <GitSidebar context={context} sessionID={slot.sessionID} options={options} />
    )
    return context.ui.slot(options.placement === "append"
      ? { append: "sidebar.content", render }
      : { prepend: "sidebar.content", render })
  },
})
