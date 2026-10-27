# Security and privacy

## Reporting a vulnerability

Please do not post exploit details, credentials, or private repository content in a public issue. Use [GitHub private vulnerability reporting](https://github.com/naveed-niazi/review-studio/security/advisories/new). If private reporting is unavailable, open a minimal issue requesting a private contact channel without describing the vulnerability.

Include the affected version/commit, operating system, reproduction steps using a fictional repository, impact, and any proposed fix. The current `main` branch is the maintenance target; fixes are not promised for older snapshots.

## Data handling

Review Studio is a single-user local application. Its HTTP server listens on loopback and is not intended for public hosting, shared servers, or multi-tenant use. It uses Host/Origin validation and a session token for mutations; Electron uses sandboxing and context isolation.

Settings, review history, PR metadata, managed clones, and raw CLI responses remain on your machine. GitHub is contacted for repository operations. Claude Code sends review context and source content to Anthropic according to the selected authentication method and that service’s terms. Local execution does not mean offline inference. Review Studio adds no analytics or telemetry of its own.

GitHub and Claude account authentication belongs to their CLIs. Optional desktop API keys use OS-backed Electron secure storage; browser keys are memory-only. Do not share the application data directory, authentication output, raw logs, or screenshots containing private information.

## Review boundaries

Claude is invoked with read-only source tools and safe mode. It does not receive shell or GitHub publishing tools. The application publishes separately, checks the reviewed commit, and defaults to requiring approval. These controls do not guarantee complete or correct findings, and read-only tool configuration is not a full OS sandbox.

Repository content and prior comments are untrusted input. Preserve these boundaries in contributions. Do not add arbitrary command execution, broad IPC bridges, or unvalidated external URLs.

## Dependency checks

Run `npm audit` for the complete development dependency tree and `npm audit --omit=dev` for server runtime dependencies. The 1.2.0 release updates Electron, the HTTP body parser, and build-tool dependencies to patched compatible versions; both audits reported no known advisories at preparation time. Electron is declared as a development dependency but is bundled into desktop installers, so reviewing only the server audit is insufficient. Reassess before distributing each release; a clean audit is not a security guarantee.

## Connection diagnostics

After a transport failure in a connection check, Review Studio sends unauthenticated HEAD requests to `https://api.github.com/` and `https://api.anthropic.com/`. These requests contain no account tokens, repository data or review content. Any HTTP response establishes reachability only; it does not verify credentials, model availability or service health. Normal CLI requests continue to use the accounts configured on your machine. Recovery state stores failure categories and retry times, not credentials.
