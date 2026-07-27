# Release process

HayaSend releases are built only from a version tag in this repository. The
workflow publishes a multi-platform container, release assets, checksums,
software bills of materials (SBOMs), an installable CLI package, and signed
build provenance.

## Maintainer checklist

1. Merge the intended changes to `main` and wait for the required `test` check.
2. Update `version` in both `package.json` and `package-lock.json`.
3. Add the release notes to `CHANGELOG.md` and open a reviewed pull request.
4. Create an annotated `vX.Y.Z` tag on the reviewed `main` commit and push it:

   ```bash
   git switch main
   git pull --ff-only
   git tag --sign v0.1.0 --message "HayaSend v0.1.0"
   git push origin v0.1.0
   ```

   If the maintainer does not have a configured signing key, stop and configure
   one rather than publishing an unsigned release tag.

5. Confirm the protected `npm` GitHub environment is configured. For the first
   npm publication, add the bootstrap secret described below; for later
   releases, confirm the npm Trusted Publisher instead.
6. Watch the `Release` workflow. It rejects a tag that does not exactly match
   `package.json`, reruns the complete validation gate, and publishes the
   GitHub release only after its assets and attestations are ready.
7. For the first release, make the `haya-inc/hayasend` package public in the
   GitHub Container Registry settings. Later releases inherit that visibility.
8. Verify the released image and checksum before announcing it:

   ```bash
   gh attestation verify \
     oci://ghcr.io/haya-inc/hayasend:0.1.0 \
     --repo haya-inc/hayasend

   gh release download v0.1.0 --repo haya-inc/hayasend --dir hayasend-release
   (
     cd hayasend-release
     sha256sum --check SHA256SUMS
   )
   ```

   On macOS, use `shasum --algorithm 256 --check SHA256SUMS` in place
   of `sha256sum`.

Stable releases publish the exact version, the `major.minor` alias, and
`latest`. Stable versions from v1 onward also publish a `major` alias.
Prerelease versions publish only their exact SemVer version. HayaSend does not
publish a floating `major` tag while it is pre-1.0.

## Published artifacts

Each release contains:

- a Git source archive from the tagged commit;
- the installable `@haya-inc/hayasend` CLI tarball;
- the versioned OpenAPI contract;
- the versioned AWS SAM template;
- a CycloneDX application SBOM;
- SHA-256 checksums for all five files;
- GitHub/Sigstore build-provenance attestations for the files and container;
- a registry-native BuildKit SBOM and maximal provenance for the multi-platform
  container.

The release workflow publishes the exact CLI tarball to
`@haya-inc/hayasend`. Stable versions use the `latest` dist-tag and
prereleases use `next`. A rerun first compares the registry's SHA-512
integrity with the local tarball: identical bytes are accepted, while a
different immutable package at the same version stops the release.

## One-time npm bootstrap

npm requires a package to exist before it can have a Trusted Publisher. For
the first publication only:

1. confirm the `haya-inc` npm organization and `@haya-inc/hayasend` name are
   controlled by Haya, Inc.;
2. create a protected GitHub environment named exactly `npm`, restrict it to
   reviewed release tags, and require a maintainer approval;
3. create a short-expiry granular npm token with bypass-2FA enabled and only
   the access needed to create this public scoped package, save it as the
   environment secret `NPM_TOKEN`, and never expose it to pull-request
   workflows;
4. run the normal signed-tag release and verify the npm package shows
   provenance for this repository and workflow;
5. using npm 11.15.0 or newer with an account protected by 2FA, configure the
   exact publisher:

   ```bash
   npm trust github @haya-inc/hayasend \
     --repo haya-inc/hayasend \
     --file release.yml \
     --env npm \
     --allow-publish \
     --yes
   ```

6. delete the `NPM_TOKEN` environment secret and revoke the bootstrap token.

Subsequent releases authenticate only with the short-lived GitHub OIDC token.
The workflow uses a GitHub-hosted runner, disables dependency caching in the
privileged release job, grants `id-token: write`, and requests npm provenance.
The package's repository URL must remain exactly tied to this public
repository or npm Trusted Publishing will refuse it.

These controls follow npm's current
[Trusted Publisher](https://docs.npmjs.com/trusted-publishers/) and
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
requirements, including the existing-package bootstrap, exact workflow and
environment identity, explicit allowed action, and account-level 2FA.

## Recovery

The GitHub release begins as a draft. For a transient failure, rerun the same
workflow; it reuses the draft and replaces partial assets before publishing.
If npm was already published, the rerun continues only when its integrity
matches the rebuilt tarball exactly. For a workflow defect, fix it on `main`.
If npm was not published and the GitHub draft was never announced or consumed,
follow the documented tag recovery process on that reviewed fix. Once npm
contains a version, never attempt to replace its bytes, even if it was not
announced: publish a new patch version.

Never move or reuse an announced release tag. Publish a new patch version
instead.
