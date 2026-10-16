# Configuration and troubleshooting

## Accounts and first launch

A fresh installation has no repositories, saved prompts, or review history. The runner starts paused, automatic queueing is off, and publication requires approval. The app checks Git, GitHub CLI, and Claude Code at startup and periodically checks connections while running.

Existing CLI sign-ins are reused. Sign in or reconnect from **Settings & connections**. A missing CLI must be installed first using the official installer linked in the app. Switching accounts also changes the account used by other processes invoking that CLI.

The desktop app discovers common Homebrew, local-bin, nvm, Volta, asdf, and mise installations. For other locations, make `git`, `gh`, and `claude` available on PATH before launching. Run `npm run doctor` from the source checkout to diagnose prerequisites.

## Review settings

| Setting                          | Default           | Available values                                                      |
| -------------------------------- | ----------------- | --------------------------------------------------------------------- |
| Publishing                       | Approval required | Approval or automatic                                                 |
| Parallel reviews                 | 2                 | 1–6                                                                   |
| Sync interval                    | 8 minutes         | 1–120 minutes                                                         |
| Review timeout                   | 30 minutes        | 1–120 minutes                                                         |
| Automatic queueing               | Off               | On or off                                                             |
| Auto-queue age window            | 15 days           | 1–365 days                                                            |
| Age measured from                | Last PR activity  | Activity or last code commit                                          |
| Claude model                     | `sonnet`          | CLI-supported alias/ID; `default` uses CLI selection                  |
| Review effort                    | `medium`          | `low`, `medium`, `high`, `xhigh`, `max`; support depends on model/CLI |
| Tests / security checks          | On                | Inherit, on, or off per repository                                    |
| Analytics / compatibility checks | Off               | Inherit, on, or off per repository                                    |

Automatic discovery skips drafts and commits with an existing review attempt. Temporary connection, service and rate-limit failures retry automatically up to three times after the initial review attempt. Other failures need a manual retry. Each sync loads up to 500 open PRs per repository and reports if that limit is reached. Older or specific PRs can be added by URL. The interface includes active work and the most recent 500 review jobs.

Both **Start runner** and automatic queueing must be enabled for unattended discovery and review. Automatic publication is a separate opt-in. Increasing concurrency consumes more of your Claude quota and machine resources.

## Prompts and check toggles

The review context combines default instructions, repository rules, effective check toggles, and per-PR focus. The engine also supplies the diff, description, and prior GitHub feedback.

A saved prompt is a reusable text template. Choosing it replaces the form’s rules/focus text; save the form to persist the result. It is not a live link to the library. Repository rules apply to future reviews of that repository. Changes do not retroactively alter already queued jobs, whose settings are captured at queue time.

Copy an [example prompt](../examples/prompts/) into the library and adapt it to your project. A disabled check means the built-in checklist is omitted; an explicit custom instruction can still request that check.

## Storage and credentials

Application data defaults to `~/.review-studio`: SQLite state and history, managed clones, temporary worktrees/context, and raw Claude response logs. This directory can contain sensitive source and review content. It is not part of the source repository.

GitHub and Claude subscription credentials remain under their respective CLIs. The desktop app can save an API key using Electron secure storage, backed by the OS credential system. Desktop preferences and the encrypted key live under Electron’s user-data directory (normally `~/Library/Application Support/Review Studio` on macOS). Browser-mode keys are memory-only and must be entered again after restarting. API usage may incur charges.

To back up data, fully quit the app first, then copy its data directory to a private location. Do not attach databases or raw response logs to public issues. There is no automatic retention limit for stored history or response logs.

Only one app/server may use a data directory at a time. Development and tests should use a separate data directory.

| Environment variable    | Purpose                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `REVIEW_STUDIO_DATA`    | Override the private application data directory                                                                                         |
| `REVIEW_STUDIO_PORT`    | Browser server port; default `8790`, `0` chooses a free port                                                                            |
| `REVIEW_STUDIO_API_KEY` | Optional browser/server API key passed through the process environment; prefer interactive setup rather than saving it in shell history |
| `PLAYWRIGHT_CHANNEL`    | Optional browser for UI tests/screenshots, e.g. `chrome`; otherwise bundled Chromium                                                    |

The desktop shell chooses a free port. Configuration is saved through the app; no `.env` file is required or automatically loaded.

## Repositories and cleanup

Connect a local clone whose `origin` matches its GitHub repository, or clone through the repository picker. Reviews use detached worktrees; they do not switch your original checkout’s branch.

Disconnecting a repository preserves its history. Only clones in the app-managed repository folder can be deleted through the app, and only when no local changes, untracked/ignored files, unpushed commits, or extra worktrees are present. Externally connected clones and custom clone destinations are not deleted by this control. Cancel queued jobs and let active work finish before removal.

## Background operation

Closing the desktop window keeps the engine in the menu bar by default. **Quit Review Studio** stops it. Interrupted jobs remain visible for retry; publication is never blindly repeated after interruption.

Start at login is opt-in and available only in the packaged application. On macOS, move the app to Applications first. Unsigned development builds may not register reliably; registration failures are shown. A paused runner remains paused across restarts.

## Connection recovery and retries

A manual pause is saved until you choose **Start runner**. Connection failures use a separate **Waiting for connections** state; they never silently turn on the manual pause. Eligible queued reviews continue after connection checks recover, unless you paused them.

The app distinguishes explicit API service errors, rate limits, expired credentials, account/spending limits, local routing failures, DNS failures and uncertain transport interruptions. An EOF or timeout alone does not prove your internet is down. When a connection check encounters a transport error, two unauthenticated endpoint probes help explain whether either service is reachable. Settings shows the category, diagnosis and next check time.

Connection checks normally run every three minutes. On failure they back off from 15 seconds (60 seconds for rate limits) to five minutes, with a small random delay. A longer `Retry-After`, when exposed by the CLI, takes precedence. Retry deadlines survive restarting the app, and **Check connections** cannot bypass a known provider cooldown.

A transient review failure retains its original queue position, commit and configuration, with up to three automatic retries using separate worktrees. Cancel the queued job to stop its retry. Repeated attempts may consume additional Claude quota. Each completed CLI response is retained per attempt. Invalid review output, changed/closed PRs, permission errors, review timeouts and account failures require manual attention. After fixing an API credential or billing problem, use **Check connections** and retry the affected failed job. Claude's local login status alone cannot verify that a credit balance or API credential has been repaired.

A failed publishing request keeps the completed review locally and requires **Retry publishing**. The app checks for its existing publication marker first because a connection may fail after GitHub has already accepted a comment. It never blindly repeats a write or reruns the review to publish it.

## Troubleshooting

- **Missing CLI or logged-out account:** run `npm run doctor`, install/update the reported tool, then reconnect in Settings. Never include tokens in an issue report.
- **Unsupported Claude option:** update Claude Code. Review Studio requires safe mode, effort control, and streaming JSON output; it will not silently remove read-only restrictions.
- **No reviews start:** check connections, the runner’s paused state, enabled repositories, and queue contents. For automatic discovery, check the auto-queue toggle and age window.
- **Invalid review verdict:** open the review’s Activity tab. Retry after resolving CLI/auth errors. Include only a redacted error excerpt in a bug report.
- **PR changed before publishing:** review the latest commit. Publication is tied to the inspected SHA.
- **Already running:** use the existing app or fully quit it. Use a separate `REVIEW_STUDIO_DATA` for development; do not remove a live process’s lock file.
- **Port in use:** set `REVIEW_STUDIO_PORT` to another local port. Desktop mode selects one automatically.
- **macOS blocks a locally built app:** development builds are unsigned. Use `npm run desktop` from source, or sign/notarize your own build following the release guide.

GitHub.com is the supported API target. GitHub Enterprise and Windows/Linux desktop behavior need separate validation.
