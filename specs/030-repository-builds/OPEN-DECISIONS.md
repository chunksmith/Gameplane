# Open decisions: Repository builds

These values are not settled yet. They are recorded here so nothing below is mistaken for a settled contract.

1. **Personal Reposilite tokens.**
   - v1: an administrator creates people's publish tokens in the Reposilite UI, using the management token in Secret `gameplane-maven-admin`.
   - To decide: should the API mint a per-user token from the Maven card? Reposilite has a token REST API. The Figma card currently says "Create a token in Reposilite".
2. **Write-token scope.** With publish on, every build holds one write token for all of `/releases` and `/snapshots`, so a hostile build script could overwrite another project's artifacts. To decide: per-repository tokens limited to the project's `groupId` path, or publishing from the operator after the build instead of inside the build pod.
3. **Build images.**
   - Image tags are pinned when the chart is written.
   - To decide: digest pinning, and whether to mirror the images into the Gameplane registry for air-gapped clusters.
4. **Cache sharing.** v1 keeps one cache volume per repository. To decide: a shared, node-local cache across repositories.
5. **Artifact retention.** Artifacts live in the working copy's `target/` and `build/libs/`, so a later build replaces them. To decide: copying them to the Maven repository or a separate volume so older builds stay deployable.
