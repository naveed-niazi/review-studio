# Packaging and releasing

The repository ships source under MIT. Current packaging targets macOS Apple Silicon. The default configuration creates an **unsigned development build**; it does not provide a signed/notarized public installer.

## Local packaging

```sh
npm ci
npm run package:mac
```

The `.app` and DMG are written to `release/`, which is ignored by Git. For an unpacked application, use `npm run package:dir`. Start-at-login is available only in the packaged app; on macOS, place it in Applications. Unsigned builds may fail login-item registration.

The optional packaged lifecycle check expects `release/mac-arm64/Review Studio.app`:

```sh
node test/desktop-check.mjs
```

It uses an isolated data directory and fake CLI accounts. It does not invoke real reviews. Quit other development Electron instances if they interfere with launch.

## Before a source release

- Work from a clean checkout. Never package a directory containing runtime data or private repository clones.
- Run `npm ci`, `npm run format:check`, `npm run check`, and `npm run audit:release`.
- Review `npm audit` and `npm audit --omit=dev`. Record unresolved issues accurately; the security policy documents the initial build-tool advisory.
- Regenerate screenshots using `npm run screenshots`; inspect each image. Never use personal accounts or PRs.
- Inspect `git diff --cached`, the complete tracked file list, and `npm pack --dry-run`. No database, account configuration, response logs, or reviewed source should be present.
- Confirm README commands from a fresh installation and test first launch with no configured repositories. Defaults must remain paused, auto-queue off, and approval required.
- Preserve the MIT license and dependency notices. The Vite build emits `dist/THIRD_PARTY_LICENSES.txt` for bundled frontend dependencies and fonts; it is included in the application. The package is marked `private` to prevent accidental npm publication; GitHub source distribution and local builds remain available.
- Tag a tested commit and write release notes stating supported platforms and remaining limitations.

## Before distributing Mac binaries

Configure an Apple Developer signing identity, remove the explicit `mac.identity: null` development setting, and configure notarization in the release environment. Keep certificates, passwords, and credentials in protected CI secrets or local secure storage, never in the repository.

Validate signing/notarization and Gatekeeper on a clean Mac. Test first-time CLI setup, already-authenticated accounts, secure key storage, app termination, background operation, and restart/login registration. Do not describe a development DMG as signed or notarized.

The committed CI builds/tests source; it does not publish binaries, use production credentials, or post GitHub reviews. Binary publication should be a separate, deliberate maintainer workflow after these checks.
