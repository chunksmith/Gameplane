package messages

import "net/http"

// repositoryEntries holds the repository and GitHub integration messages (spec 029).
var repositoryEntries = []Entry{
	{
		ID:          "server.repositories.token_invalid",
		English:     "GitHub did not accept this token.",
		Description: "GitHub integration error when saving a personal access token that GitHub rejects or that is malformed.",
		Status:      http.StatusUnprocessableEntity,
	},
	{
		ID:          "server.repositories.github_token_required",
		English:     "Connect your GitHub token in Settings, Integrations first.",
		Description: "Repository error when a Git operation that talks to GitHub, or a commit that needs the user's GitHub identity, runs without a saved GitHub token.",
		Status:      http.StatusPreconditionRequired,
	},
	{
		ID:          "server.repositories.remote_not_allowed",
		English:     "Only HTTPS github.com repository URLs are supported.",
		Description: "Repository error when the repository URL is not https://github.com/OWNER/REPO.",
		Status:      http.StatusBadRequest,
	},
	{
		ID:          "server.repositories.invalid_name",
		English:     "The repository name must be a lowercase DNS label.",
		Description: "Repository error when the name is not a DNS-1123 label (lowercase letters, digits and hyphens, at most 63 characters).",
		Status:      http.StatusBadRequest,
	},
	{
		ID:          "server.repositories.invalid_branch",
		English:     "The branch name is not valid.",
		Description: "Repository error when the requested branch name is not a valid Git branch name.",
		Status:      http.StatusBadRequest,
	},
	{
		ID:          "server.repositories.invalid_storage",
		English:     "The disk size is not valid.",
		Description: "Repository error when the requested disk size is not a positive Kubernetes quantity such as 2Gi.",
		Status:      http.StatusBadRequest,
	},
	{
		ID:          "server.repositories.name_taken",
		English:     "A server or repository with this name already exists in this namespace.",
		Description: "Repository error when the name is already used by a game server or repository in the same namespace.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.network_not_found",
		English:     "network not found",
		Description: "Repository error when the selected network does not exist.",
		Status:      http.StatusBadRequest,
	},
	{
		ID:          "server.repositories.owner_not_collaborator",
		English:     "The owner cannot be added as a collaborator.",
		Description: "Repository error when the owner is added to the repository's collaborators.",
		Status:      http.StatusBadRequest,
	},
	{
		ID:          "server.repositories.agent_unavailable",
		English:     "The repository agent is not reachable.",
		Description: "Repository error when the repository's agent pod does not answer.",
		Status:      http.StatusServiceUnavailable,
	},
	{
		ID:          "server.repositories.busy",
		English:     "Another Git operation is running on this repository. Try again in a moment.",
		Description: "Git error when another Git command holds the repository lock.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.dirty",
		English:     "Commit or discard your changes before switching branches.",
		Description: "Git error when switching branches with uncommitted changes.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.conflict",
		English:     "The changes conflict and were not applied.",
		Description: "Git error when a pull (rebase) or revert hits conflicts; the operation was aborted and the response lists the files.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.push_rejected",
		English:     "GitHub rejected the push because the branch has new commits. Pull first.",
		Description: "Git error when a push is rejected as non-fast-forward.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.already_pushed",
		English:     "This commit is already pushed and cannot be undone.",
		Description: "Git error when undoing a commit that is already on the remote.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.not_empty",
		English:     "The working copy is not empty.",
		Description: "Git error when cloning into a working copy that already has files.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.git_dir",
		English:     "The .git folder cannot be opened or changed.",
		Description: "Repository file error when a path inside the .git folder is requested.",
		Status:      http.StatusForbidden,
	},
	{
		ID:          "server.repositories.bad_request",
		English:     "The Git request was not valid.",
		Description: "Git error for a malformed Git request, for example a missing path or an invalid branch name.",
		Status:      http.StatusBadRequest,
	},
	{
		ID:          "server.repositories.too_large",
		English:     "The diff or request is too large.",
		Description: "Git error when a diff or commit exceeds 5 MiB or the request body exceeds 1 MiB.",
		Status:      http.StatusRequestEntityTooLarge,
	},
	{
		ID:          "server.repositories.git_failed",
		English:     "Git could not complete the operation.",
		Description: "Git error when the git command fails; the response output has Git's message.",
		Status:      http.StatusUnprocessableEntity,
	},
	{
		ID:          "server.repositories.not_found",
		English:     "The commit, branch or file was not found.",
		Description: "Git error when the requested commit, branch or path does not exist.",
		Status:      http.StatusNotFound,
	},
	{
		ID:          "server.repositories.internal",
		English:     "The repository agent hit an internal error.",
		Description: "Git error for an unexpected failure in the repository agent.",
		Status:      http.StatusInternalServerError,
	},
}
