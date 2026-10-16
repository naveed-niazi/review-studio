# Architecture

Review Studio has three layers: a React interface, a local Node.js engine, and an optional Electron desktop shell. SQLite is the source of truth for queue order, settings, PR metadata, jobs, and events. No hosted Review Studio backend is involved.

```text
React UI ── HTTP / server-sent events ── Express API
                                           │
                                        SQLite
                                           │
                                     review engine
                                      /         \
                                 GitHub CLI   Claude Code CLI
                                      \         /
                                   Git worktrees

Electron shell: local engine lifecycle, menu bar, login preference,
folder picker, and OS-backed API-key storage.
```

| Location                 | Responsibility                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `server/index.js`        | Loopback API, request validation, connections, process lifecycle                       |
| `server/store.js`        | Schema, safe defaults, durable jobs, queue ordering, settings snapshots                |
| `server/engine.js`       | PR discovery, worktrees, prompts, review output validation, publishing                 |
| `server/connections.js`  | Failure classification, persisted recovery state, connectivity diagnostics and backoff |
| `server/process.js`      | Subprocess execution, cancellation, timeouts, repository parsing                       |
| `server/rules.js`        | Built-in checks and validation                                                         |
| `src/main.jsx`           | Workspace pages, queue, repository forms, review details, settings                     |
| `src/styles.css`         | UI tokens, layouts, responsive behavior                                                |
| `desktop/main.cjs`       | Sandboxed window, engine process, tray, secure credentials, login items                |
| `desktop/preload.cjs`    | Narrow renderer-to-desktop bridge                                                      |
| `test/core.test.js`      | Store/engine tests with disposable Git repositories                                    |
| `test/http.test.js`      | HTTP isolation/security tests and shared fake-CLI fixture                              |
| `test/ui-check.mjs`      | End-to-end browser acceptance                                                          |
| `test/desktop-check.mjs` | Packaged Mac lifecycle smoke test with isolated fake accounts                          |
| `scripts/`               | Setup diagnostics, demo screenshots, publication hygiene                               |

## Review lifecycle

1. Sync PR metadata asynchronously and notify the UI through server-sent events. Cached state requests never wait for GitHub.
2. Queue a PR and capture its model, effort, publishing policy, and effective instructions/checks.
3. Fetch the exact head commit and create a detached worktree. Serialize Git operations per clone while allowing reviews across worktrees to run concurrently.
4. Supply Claude the diff and context with read-only tools. Do not grant shell access, repository hooks, or publishing tools.
5. Validate successful CLI completion and a recognized, unambiguous verdict. Save the result or an actionable failure.
6. Hold for approval or publish automatically. Recheck the current head and use a per-job marker to reconcile uncertain network outcomes without duplicate publication.
7. Remove temporary context/worktrees and report cleanup failures. Retain review history and raw CLI responses locally.

## Extension points

- **New review checks:** define the check in `server/rules.js`, add a default in the store, expose an interface label/toggle, and test inherited versus overridden behavior.
- **Prompt templates:** templates are text in SQLite. Selection copies text into a form; queued jobs snapshot the resulting instructions. Avoid introducing invisible changes to already queued work.
- **New settings:** add a default, validate all writes in the API, expose the setting, and document whether it applies immediately or only to new jobs.
- **Schema changes:** add backward-compatible migrations in the store. Test existing data and interrupted-job recovery. Never silently discard review history.
- **Additional platforms:** validate CLI discovery, process-tree cancellation, credential storage, tray behavior, login registration, and packaging before claiming support.

## Trust boundaries

Bind only to loopback. Validate Host/Origin and require the session token for mutations. Treat PR descriptions, diffs, comments, and model output as untrusted content. Keep Electron sandboxing and context isolation enabled; expose only narrow IPC operations and verify senders. Credentials must never be included in state responses or committed fixtures.

The CLI’s read-only tool configuration limits available actions; it is not an operating-system sandbox or a guarantee against prompt injection. Human review remains valuable, especially before enabling automatic publication. See [SECURITY.md](../SECURITY.md).
