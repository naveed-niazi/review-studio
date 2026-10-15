# Contributing to Review Studio

Thanks for helping improve local GitHub code review workflows. Small, focused pull requests are easiest to review. For a substantial feature or architecture change, open an issue first to agree on scope. Documentation, accessibility, onboarding, and platform testing are welcome contributions too.

## Development setup

Use Node.js 22.13+ and npm. Fork this repository, clone your fork, and run `npm ci`. No GitHub or Claude credentials are needed for the automated tests.

Use an isolated data directory so development cannot touch your everyday queue:

```sh
REVIEW_STUDIO_DATA="$PWD/.data/dev" npm start
```

In a second terminal:

```sh
npm run dev
```

Open the Vite URL printed in the terminal. API requests proxy to the backend on port 8790. Keep that port for this two-process workflow, or update the local proxy configuration if you change it.

For desktop development:

```sh
REVIEW_STUDIO_DATA="$PWD/.data/dev" npm run desktop
```

Manual reviews require your own CLI connections. Keep the runner paused until you deliberately queue a test PR. Do not use automatic publication against somebody else’s repository to test changes.

## Checks

```sh
npm run format
npm test
npm run build
npx playwright install chromium
npm run test:ui
npm run audit:release
```

`npm run check` runs unit/integration tests, the production build, and browser acceptance tests. `npm run format:check` verifies formatting. To use installed Google Chrome instead of bundled Chromium, set `PLAYWRIGHT_CHANNEL=chrome` for UI tests.

Tests use temporary SQLite databases, disposable Git repositories, and fake GitHub/Claude executables. They do not submit reviews or invoke paid model calls. Preserve that isolation when adding tests. Cover behavior that could regress, especially queue ordering, cancellation, output validation, exact-commit publishing, credential handling, and filesystem boundaries.

Regenerate the README’s screenshots with `npm run screenshots`. This launches the actual UI against fictional fixtures. Never use screenshots of private repositories, real account details, or personal review history.

## Finding your way around

See [architecture](docs/architecture.md) for component boundaries and extension points. Use Prettier for source formatting; keep changes focused rather than rewriting unrelated files. Add documentation for user-visible behavior and settings. Explain why a non-obvious safeguard exists in a concise code comment.

## Pull requests

1. Create a branch in your fork.
2. Make the change and run the relevant checks.
3. Update documentation and add isolated regression coverage where needed.
4. Inspect `git diff --cached` and run `npm run audit:release`. It is a guardrail, not a substitute for reviewing your patch.
5. Open a pull request describing the problem, resulting behavior, and validation. Include demo-data screenshots for visible UI changes.

Do not commit databases, `.env` files, authentication output, API keys, source from reviewed repositories, local paths, generated builds, or runtime logs. Dependencies should have a clear purpose and compatible licensing. Keep the lockfile in sync with package changes.

## Community expectations

Be respectful, discuss the code rather than the person, and avoid sharing anyone’s private information. Report vulnerabilities privately through the process in [SECURITY.md](SECURITY.md). Ordinary bugs and feature requests belong in public issues with sensitive details removed.

Contributions are provided under the project’s [MIT license](LICENSE). Retain applicable third-party notices when incorporating external code or assets.
