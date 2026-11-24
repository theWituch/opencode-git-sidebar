# Git Sidebar for OpenCode

A read-only plugin that shows working tree status and recent commits in the [OpenCode](https://opencode.ai/) terminal UI.

- **See what changed at a glance.** The collapsible Git section keeps status counters visible even when collapsed.
- **Scan recent history.** By default, the sidebar shows the two most recent commits from `HEAD`, each with a short hash and a one-line subject. Long subjects scroll left, pause, and scroll back right before the next long subject starts. Hashes stay fixed.
- **Inspect commits without leaving the session.** Click a commit to see its full hash and message, author, author date, and changed files.

## Installation

**Requirements:** OpenCode 2.4.1 and `git` on the machine running the terminal client, with `git` available on `PATH`. Node.js 26.4 or later and npm are recommended for installing dependencies and running tests.

### Install from GitHub

Install directly from GitHub without cloning the repository or using an npm account:

```sh
opencode plugin add github:theWituch/opencode-git-sidebar
```

### Install from source

1. Download or clone this repository and run `npm ci` from its root.
2. Add the entry below to the `plugins` array in your [global `cli.json`](https://opencode.ai/docs/cli/config#configuration-file), keeping any existing entries. Replace `PLUGIN_DIRECTORY_FILE_URL` with the absolute `file:` URL of the directory containing the plugin's `package.json`. Use `cli.json`, not `opencode.json`, because this is a terminal-only plugin.

   ```json
   {
     "$schema": "https://opencode.ai/v2/cli.json",
     "plugins": [
       {
         "package": "PLUGIN_DIRECTORY_FILE_URL"
       }
     ]
   }
   ```

3. Open a local OpenCode session in a Git repository. If the session sidebar is hidden, widen the terminal or use the command palette (`Ctrl+P`) to show it.

OpenCode reloads valid changes to `cli.json` automatically. Use `/reload` if needed.

## Configuration

Add an `options` object alongside `package` in the plugin entry to override any of these defaults:

| Option | Default | Description |
| --- | --- | --- |
| `showStatus` | `true` | Show working tree status and upstream divergence. |
| `showCommits` | `true` | Show recent commits. Set to `false` for a status-only view. |
| `scrollCommits` | `true` | Scroll long commit subjects. Set to `false` to truncate them to the sidebar width without scrolling. |
| `commitCount` | `2` | Maximum number of commits, from `0` to `50`. Set to `0` to hide the list even if `showCommits` is enabled. |
| `refreshIntervalMs` | `10000` | Refresh interval, from `1000` to `60000` ms. Refreshes run only while the sidebar section is mounted. |
| `placement` | `"prepend"` | Use `"prepend"` to place Git before the session sidebar content or `"append"` to place it after. |

Omitted or invalid values fall back to defaults. Out-of-range integers are clamped to the nearest limit. The section is hidden outside Git repositories or when both status and the commit list are disabled.

## Usage

Click `▼ Git` to collapse the section or `▶ Git` to expand it. With scrolling enabled, long commit subjects start scrolling after five seconds, pause at the end for two seconds, then scroll back to the start.

Click a commit to open its details. The full message is available immediately; author information and changed files load from Git when the dialog opens. Renames show both paths, and merge commits show changes relative to their first parent. Press `Esc` to close the dialog.

### Status counters

A header might look like `▼ Git +2 ±3 ?1 S4 ↑3 ↓1 +14L -6L`, or `▼ Git Clean` when there are no local changes. The header shows `Git unavailable` if Git data could not be read. An expanded, enabled commit list shows `No commits` when empty. Colors follow the active OpenCode theme.

| Counter | Meaning |
| --- | --- |
| `+2` | Two newly staged files. |
| `±3` | Three other changed tracked files. |
| `?1` | One untracked entry. Git may count an entire untracked directory as one entry. |
| `!1` | One conflicted file. |
| `S4` | Four files with staged changes, including newly staged files counted under `+`. |
| `↑3` / `↓1` | Three commits ahead of upstream and one behind, based on local refs. The plugin does not fetch. |
| `+14L` / `-6L` | Fourteen lines added and six removed in tracked files. |

Line counts compare the current tracked content against `HEAD` (or an empty tree before the first commit). They include staged and unstaged changes without double-counting and exclude untracked files, binary content, and submodule pointers.

> **Local sessions only.** The plugin reads Git data on the machine running the terminal client and does not modify the repository. Do not use it to inspect a remote session: a matching directory on the client machine could show data from a different repository.

## License

This project is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`). See [LICENSE](LICENSE).

## Development

From the repository root:

```sh
npm ci
npm run check
npm run pack:dry
```

Integration tests create temporary Git repositories. For a TUI smoke test, open a repository with at least three commits whose two latest commits have long subjects. Check that only two rows appear by default and that the subjects scroll without moving the hashes. Open a commit with a multiline message and a renamed file to check both the full message and the old and new paths. Then edit a tracked text file and confirm the line counts update and remain visible when the section is collapsed.
