# Release process

HayaSend releases are built only from a version tag in this repository. The
workflow publishes a multi-platform container, release assets, checksums,
software bills of materials (SBOMs), and signed build provenance.

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

5. Watch the `Release` workflow. It rejects a tag that does not exactly match
   `package.json`, reruns the complete validation gate, and publishes the
   GitHub release only after its assets and attestations are ready.
6. For the first release, make the `haya-inc/hayasend` package public in the
   GitHub Container Registry settings. Later releases inherit that visibility.
7. Verify the released image and checksum before announcing it:

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
- the versioned OpenAPI contract;
- the versioned AWS SAM template;
- a CycloneDX application SBOM;
- SHA-256 checksums for all four files;
- GitHub/Sigstore build-provenance attestations for the files and container;
- a registry-native BuildKit SBOM and maximal provenance for the multi-platform
  container.

The project is intentionally not published to npm: users call HayaSend through
the official Resend SDK, direct HTTP, or the container image.

## Recovery

The GitHub release begins as a draft. For a transient failure, rerun the same
workflow; it reuses the draft and replaces partial assets before publishing.
For a workflow defect, fix it on `main`. If the draft was never announced or
consumed, delete and recreate the tag on that reviewed fix, then let the new
tag event run. Otherwise publish a new patch version.

Never move or reuse an announced release tag. Publish a new patch version
instead.
