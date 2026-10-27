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
| Total review limit               | 30 minutes        | 1–120 minutes                                                         |
| Inactivity timeout               | 5 minutes         | 2–30 minutes without CLI output                                       |
| Recover failed reviews           | On                | On or off, independent of automatic discovery                         |
| Failed review recheck            | 5 minutes         | 2–120 minutes                                                         |
| Automatic queueing               | Off               | On or off                                                             |
| Auto-queue age window            | 15 days           | 1–365 days                                                            |
| Age measured from                | Last PR activity  | Activity or last code commit                                          |
| Claude model                     | `sonnet`          | CLI-supported alias/ID; `default` uses CLI selection                  |
| Review effort                    | `medium`          | `low`, `medium`, `high`, `xhigh`, `max`; support depends on model/CLI |
| Tests / security checks          | On                | Inherit, on, or off per repository                                    |
| Analytics / compatibility checks | Off               | Inherit, on, or off per repository                                    |

Automatic discovery skips drafts and commits with an existing review attempt. Temporary connection, service and rate-limit failures retry automatically up to three times after the initial review attempt. A separate recovery pass rechecks eligible failed reviews, including exhausted retries, timeouts and interruptions. Each sync loads up to 500 open PRs per repository and reports if that limit is reached. Older or specific PRs can be added by URL. The interface includes active work and the most recent 500 review jobs.

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

Closing the desktop window keeps the engine in the menu bar by default. **Quit Review Studio** stops it. Interrupted reviews are eligible for automatic recovery; publication is never blindly repeated after interruption.

Start at login is opt-in and available only in the packaged application. On macOS, move the app to Applications first. Unsigned development builds may not register reliably; registration failures are shown. A paused runner remains paused across restarts.

## Connection recovery and retries

A manual pause is saved until you choose **Start runner**. Connection failures use a separate **Waiting for connections** state; they never silently turn on the manual pause. Eligible queued reviews continue after connection checks recover, unless you paused them.

The app distinguishes explicit API service errors, rate limits, expired credentials, account/spending limits, local routing failures, DNS failures and uncertain transport interruptions. An EOF or timeout alone does not prove your internet is down. When a connection check encounters a transport error, two unauthenticated endpoint probes help explain whether either service is reachable. Settings shows the category, diagnosis and next check time.

Connection checks normally run every three minutes. On failure they back off from 15 seconds (60 seconds for rate limits) to five minutes, with a small random delay. A longer `Retry-After`, when exposed by the CLI, takes precedence. Retry deadlines survive restarting the app, and **Check connections** cannot bypass a known provider cooldown.

A transient connection failure retains its original queue position, commit and configuration, with up to three immediate retries using separate worktrees. After that, or after a timeout, interruption or unusable review result, **Automatically recover failed reviews** rechecks the PR after the configured delay. The scheduler checks due work every 30 seconds, at most ten PRs per pass; a large backlog can take additional passes. It verifies current GitHub state before queueing work, skips closed/merged PRs, waits on drafts, and avoids duplicating newer attempts or completed reviews. If the commit changed, it queues the latest commit with current rules and the previous per-PR focus. Otherwise it retains the original job configuration and adds the retry to the back of the queue.

Recovery allows three additional attempts per job in a rolling 24-hour window; once that budget is used, it waits until the window resets. This count and the next check survive restarting the app. These attempts are in addition to the initial connection retries and may consume Claude quota. Cancel a queued or recovering job to stop retries for that attempt, or turn recovery off in Settings. Manual pauses stop recovery as well as reviews. Permission problems, unrecognized errors and diffs above the 128 MiB file limit still need attention; publishing failures remain separate and are not automatically posted again.

**Inactivity timeout** defaults to five minutes with no CLI output, independently of the 30-minute total review limit. Partial Claude output resets the inactivity timer without filling Activity with token-by-token messages. An active long review can continue until its total limit; a silent process fails sooner and enters recovery. This detects output inactivity, not a guarantee that the model is making useful progress. Adjust both limits for your workloads. Large diffs stream to a private file instead of being buffered in memory, and are never silently truncated.

After fixing an API credential or billing problem, use **Check connections**. Eligible failures then enter normal recovery. Claude's local login status alone cannot verify that a credit balance or API credential has been repaired. Completed CLI responses are retained per attempt; timeout/cancellation details remain in Activity.

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

## Reviewed PRs and merging

The Pull requests view shows the latest completed **Review Studio** verdict and Action line, including reviews older than the recent activity window. The **Reviewed** tab includes reviews of the current commit; **Outdated reviews** separates reviews invalidated by newer commits or a changed target branch. Filter by verdict, repository, target branch, or environment, and sort by latest activity, latest review, or age. A newer queued, failed, or running review can appear alongside the previous verdict; merging waits for the newer attempt to finish.

Repository settings map exact target branch names to **DEV** and **PROD** labels. Unmapped branches show **OTHER**. Titles and source branch names never determine the environment. The initial labels use `dev`, `develop`, and `development` for DEV and `main`, `master`, `prod`, and `production` for PROD; change these to match your repository.

Choose **Merge…** to read the latest review and check GitHub's current requirements. The confirmation shows the source and target branches, reviewed commit, checks, and all three GitHub methods:

- **Create a merge commit:** retain the branch's commits and add a merge commit.
- **Squash and merge:** combine the PR into one commit on the target branch.
- **Rebase and merge:** replay the PR commits on the target branch without a merge commit.

Methods disabled by the GitHub repository are shown as unavailable. Review Studio does not delete branches, run local merge commands, or use an administrator bypass. It requires a current non-blocking local review of the same target branch, no newer unfinished review attempt, a non-draft open PR, write permission, a clean GitHub merge state, satisfied GitHub reviews, and successful checks (neutral/skipped checks are accepted). Conflicts, behind-base branches, pending/unknown states, and missing check data prevent the merge. Repositories requiring a merge queue must use GitHub's queue; this version does not enqueue merges there.

Reviews created before 1.2.0 remain visible, but do not record which target branch was reviewed. Run a fresh review before merging those PRs through the app.

### Automatic merge rules

Automatic merging is **off by default**. In **Repositories → Configure → Branches & merging**, add one rule per exact target branch. Each rule chooses accepted verdicts and a merge method. For example: target `dev`, verdicts `LGTM` and `NON-BLOCKING`, method **Create a merge commit**. `NON-BLOCKING BUT FIX` is available only when explicitly selected; `BLOCKING` is never eligible.

Saving a rule authorizes matching existing and future open PRs. Automatic merging additionally requires the review to be **published**, so reviews awaiting approval are not merged automatically. Pausing the runner pauses automatic merging. Removing the rule or disabling the repository stops subsequent automatic merges. Removing a repository clears its automatic merge rules; reconnecting it requires setting those rules again. A request already sent to GitHub cannot be cancelled by changing a setting.

Eligible PRs are checked every minute, at most five per pass with rotation across repositories. Pending checks are revisited without consuming a merge attempt. Immediately before sending a merge, the app checks the live PR and current settings again, then sends GitHub the exact reviewed head SHA. New pushes cause GitHub to reject a mismatched SHA. GitHub's merge API has no atomic base-branch precondition: the preview and final check catch observed retargeting, but a retarget in the small interval after that check remains a platform limitation. Avoid retargeting a PR while a merge is in progress.

Each submitted merge is recorded in **Recent merge attempts**. A failure or lost response is never automatically resubmitted for that commit. **Check status** can reconcile an uncertain outcome when GitHub reports the PR merged. If the PR remains open with an uncertain outcome, verify it on GitHub rather than retrying blindly. An explicit rejection can be retried manually after its cause is resolved. No app restart repeats an uncertain merge.
