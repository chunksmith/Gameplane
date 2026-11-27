# Open decisions: Linear issues

These values are not settled yet. They are recorded here so nothing below is mistaken for a settled contract.

1. **Repository links storage.** v1 keeps them per user in the API database. To decide: shared per workspace, or a field on the `Repository` CRD.
2. **Move to In Progress without `linearWrite`.** v1 allows it because the user clicked Start solving. To decide: whether an admin who turned `linearWrite` off expects no status changes at all.
3. **List refresh.** v1 polls every 60 s while the page is visible. To decide: Linear webhooks.
4. **Row and header details not in v1.** The approved frames show `build #N`, `replied by Assistant` and `deployed by Assistant` on list rows and `signed in as @user` in the header. v1 shows only the linked conversation's state (solving, waiting for approval, finished, stopped) and no signed-in user. To decide: derive row states from the conversation's tool calls or store them on the conversation, and read the Linear viewer for the header.
5. **Repository links schema.** v1 stores `namespace` next to `repository` in `linear_repo_links` because repositories are namespaced; spec.md lists the table without it.
6. **Status filter with several statuses.** Linear's `list_issues` takes one `state`, so v1 makes one call per selected status (no paging across them). To decide: whether that is enough or a GraphQL query is needed.
7. **Repository links store location.** revive requires doc comments on exported `db` methods and the maintainer's rules forbid code comments, so v1 keeps the `linear_repo_links` queries unexported in `api/internal/handlers/ai_linear.go` instead of `api/internal/db` (maintainer decision, 2026-11-27).
