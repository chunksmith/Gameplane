---
name: ship-branch
description: "Use when a branch is ready to become a PR, or a merged PR needs closing out — encodes this repo's PR target (chunksmith/Gameplane only, never upstream), labels, and branch-hygiene rules."
---

## Push & Watch CI

1. Ensure every commit is signed (`git commit -s`) and carries no `Co-Authored-By` or `Claude-Session` trailer (rule 11).

2. Push the feature branch (never to `master`):
   ```sh
   git push -u origin <branch-name>
   ```

3. Watch the CI run on GitHub Actions. The suite must **pass on CI**, not locally (rule 8):
   ```sh
   gh run watch
   # or for a specific run:
   gh run view <run-id> --watch
   ```

4. If CI fails, fix the issue and create a **new commit** (never amend):
   ```sh
   git commit -s -m "fix: <short message>"
   git push
   ```
   - The new commit re-triggers CI automatically.
   - Repeat until the branch is green.

5. **Do not request review until CI is green.** Get the branch fully passing before asking.

## Create the PR

6. Open the PR on `chunksmith/Gameplane` only (rule 19). **NEVER** open a PR against `GameplanePanel/Gameplane` or any other upstream; `origin` is a fork, so `--repo` is mandatory:
   ```sh
   gh pr create --repo chunksmith/Gameplane --base master --head <branch-name> --title "brief title (under 70 chars)" --body "$(cat <<'EOF'
   ## Summary
   - Change 1
   - Change 2

   ## Test plan
   - [ ] Manual test step 1
   - [ ] Manual test step 2

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   https://claude.ai/code/session_<id>
   EOF
   )"
   ```

7. **Mandatory labels** (rule 14) — at least one `type:` and one `area:`, plus `breaking` if applicable:

   **Add labels via REST API** (rule 14: `gh pr edit` is broken on this repo):
   ```sh
   # Example: type:fix + area:api
   gh api -X POST repos/chunksmith/Gameplane/issues/<PR_NUMBER>/labels \
     -f "labels[]=type: fix" \
     -f "labels[]=area: api"
   ```

   **Type labels** (pick one): `type: feature`, `type: fix`, `type: refactor`, `type: test`, `type: ci`, `type: chore`, `type: docs`, `type: security`

   **Area labels** (pick one or more): `area: operator`, `area: api`, `area: agent`, `area: web`, `area: modules`, `area: chart`, `area: e2e`, `area: specs`, `area: shared`, `area: optional-components`

   **Special labels** (if applicable): `breaking` (for CRD/API/chart changes)

8. Verify labels were applied:
   ```sh
   gh api repos/chunksmith/Gameplane/issues/<PR_NUMBER>/labels \
     -q '[.[].name]|join(", ")'
   ```

## Await Maintainer Merge

9. The PR now waits on the maintainer (rule 12: agents never merge). Do not use `gh pr merge`, `--admin` or any other bypass.

10. Watch for the maintainer's approval and merge. Once merged:

## Clean Up After Merge

11. Delete the remote branch:
    ```sh
    git push origin --delete <branch-name>
    ```

12. Delete the local branch:
    ```sh
    git branch -d <branch-name>
    ```

13. **Do not delete unmerged branches** or stacked children whose descendants still depend on them (merge bottom-up first).

## Notes

- **PRs only on `chunksmith/Gameplane`** (rule 19): head and base both in the fork, never upstream.
- **Never push to `master`** (rule 12); a human merges.
- **Codegen output** (e.g., CRD regenerates per rule 7) goes in the same commit as the source change that triggered it.
- **Breaking changes** to CRDs, API, or the Helm chart require the `breaking` label (rule 14).
- **Session URL**: both the PR body footer and the commit trailer must cite the session that produced the work.
