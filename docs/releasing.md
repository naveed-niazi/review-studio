# Building and releasing

Review Studio uses GitHub Actions for build artifacts and public releases. Local packaging remains available for development; maintainers do not need to upload binaries manually.

## Triggers

| Event                                    | Result                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Pull request                             | CI tests, production frontend build, UI acceptance, and source publication checks       |
| PR affecting application/packaging files | Additional Mac packaging and packaged lifecycle checks                                  |
| Push to `main`                           | Tested Apple Silicon installer uploaded as a workflow artifact, retained for seven days |
| Push of `v<package-version>` tag         | Verified installer published as a GitHub prerelease with checksums and provenance       |
| Manual workflow dispatch                 | Build artifact only; never publishes a release                                          |

Find development builds in **Actions → macOS build and release → run → Artifacts**. GitHub requires sign-in to download workflow artifacts. Public release downloads are on the repository’s Releases page.

## Release a version

1. Update `package.json` and `package-lock.json` together, using `npm version 1.1.0 --no-git-tag-version` for example. Update versioned download links in the README and add `docs/releases/<version>.md` with the changes and upgrade notes. The publisher includes this file in the release and refuses to publish without it.
2. Open a PR and review the changes. Merge only after relevant CI and packaging checks pass.
3. Update your checkout and tag the reviewed commit:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v1.1.0 -m "Review Studio 1.1.0"
   git push origin v1.1.0
   ```

4. Follow the **macOS build and release** run. The tag must exactly match the package version and its commit must be reachable from `main`.
5. Confirm the public release contains the DMG and `SHA256SUMS`, then inspect the installation notes and download links.

The workflow builds on a fresh GitHub-hosted Apple Silicon runner. It runs automated tests, UI acceptance, source checks, production dependency audit, packaging, an isolated desktop lifecycle test, and package inspection. It verifies and mounts the DMG to confirm the packaged app matches the tested archive. Only the installer and checksum file are uploaded; builder logs and configuration are excluded.

The publishing job runs separately with limited release/attestation permissions. It downloads the verified artifact, rechecks the checksum, records GitHub provenance, and stages a draft release. The release becomes public only after GitHub reports the expected installer digest. Build jobs have read-only repository access, checkout credentials are not persisted, and action versions are pinned to full commit hashes. Pull requests and manual dispatches cannot publish releases.

## Verify a download

Download both assets into the same folder:

```sh
shasum -a 256 -c SHA256SUMS
gh attestation verify Review-Studio-1.1.0-arm64.dmg --repo naveed-niazi/review-studio
```

Checksums verify file integrity. Provenance links an artifact to its GitHub workflow and source commit; it is not a security audit or an Apple signature. See [GitHub’s artifact attestation documentation](https://docs.github.com/en/actions/concepts/security/artifact-attestations).

## Recover from a failed run

A failed build publishes nothing. If upload or final publication fails, the release stays a draft. After diagnosing the problem, rerun the failed job; the publisher may replace assets in that unpublished draft. It refuses to replace a public release. This repository also enables [GitHub release immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases), which locks published assets and their version tags. Enable that setting under **Settings → General → Releases** when adopting this workflow in another repository. Publish a new version for changes to released binaries, and do not move existing version tags.

No personal GitHub token is needed: release jobs use the repository-scoped Actions token. Claude/GitHub user accounts and API keys are not needed for tests or packaging. Do not add production review credentials to this workflow.

## Signing and notarization

Current installers are **ad-hoc signed, unnotarized previews** for Apple Silicon Macs on macOS 13+. All automated releases are explicitly marked prerelease. Gatekeeper may block first launch, and login-item registration may be unreliable.

Ad-hoc signing uses `mac.identity: "-"` to give the app its own bundle identity for native macOS notifications. It does not establish developer identity or bypass Gatekeeper. The build job explicitly enables ad-hoc signing for PR builds, disables certificate auto-discovery, and receives no signing secrets. Keep any future Developer ID signing in a separate protected release job, never in PR builds. A stable release requires an Apple Developer signing identity replacing that setting, notarization configuration, and protected signing credentials. Developer ID signing and notarization are not configured yet. Keep certificates/passwords in protected release secrets or secure local storage, never in Git. Before declaring stable support, validate signing, notarization, Gatekeeper, first-time authentication, encrypted key storage, background behavior, and login startup on a clean Mac.

The known build-tool advisory is recorded in [SECURITY.md](../SECURITY.md). Reassess it before stable distribution. Intel, Windows, and Linux installers require their own validated build and test workflows.

## Local packaging

```sh
npm ci
npm run package:mac
node test/desktop-check.mjs
npm run verify:package
```

Outputs live under the ignored `release/` directory. `package:mac` explicitly disables electron-builder’s automatic publishing. `package:dir` creates an unpacked app. The Vite build includes frontend and font notices in `dist/THIRD_PARTY_LICENSES.txt`; retain those and the MIT license in distributions.
