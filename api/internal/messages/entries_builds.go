package messages

import "net/http"

var buildEntries = []Entry{
	{
		ID:          "server.repositories.builds.active",
		English:     "A build of this repository is still running. Wait for it or cancel it.",
		Description: "Build error when a new build or a cache clear is requested while another build of the repository is queued, pending or running.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.builds.not_ready",
		English:     "The repository is not ready. Wait until its working copy is cloned.",
		Description: "Build error when a build starts before the repository agent is ready or its Git status cannot be read.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.builds.no_project",
		English:     "No pom.xml or build.gradle was found in the repository. Choose the build tool in Settings.",
		Description: "Build error when the build tool is auto and the repository root has neither a Maven nor a Gradle project file.",
		Status:      http.StatusUnprocessableEntity,
	},
	{
		ID:          "server.repositories.builds.log_gone",
		English:     "The build log is gone because its pod was removed.",
		Description: "Build error when the log of a build is requested after its pod no longer exists.",
		Status:      http.StatusNotFound,
	},
	{
		ID:          "server.repositories.builds.not_succeeded",
		English:     "Only a successful build can be deployed.",
		Description: "Build deploy error when the build has not finished successfully.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.builds.artifact_unknown",
		English:     "This build has no such artifact.",
		Description: "Build deploy error when the requested artifact path is not among the build's artifacts.",
		Status:      http.StatusNotFound,
	},
	{
		ID:          "server.repositories.builds.artifact_changed",
		English:     "The artifact changed after this build, or it is gone. Deploy a newer build.",
		Description: "Build deploy error when the artifact's SHA-256 no longer matches the build record because a later build overwrote it.",
		Status:      http.StatusConflict,
	},
	{
		ID:          "server.repositories.builds.bad_target",
		English:     "A deploy target is not valid or is listed twice.",
		Description: "Build deploy error when a target server name is malformed, a namespace is invalid, or the same target is listed twice, or when there are no targets or more than 50.",
		Status:      http.StatusUnprocessableEntity,
	},
	{
		ID:          "server.repositories.builds.target_forbidden",
		English:     "You may not write to one of the target servers. Nothing was written.",
		Description: "Build deploy error when the caller lacks servers:write on a target server; the deploy stops before any write.",
		Status:      http.StatusForbidden,
	},
	{
		ID:          "server.repositories.builds.bad_path",
		English:     "The folder, file name or removed file names are not valid.",
		Description: "Build deploy error when the target folder, the file name or a removed jar name is not a safe relative name ending in .jar.",
		Status:      http.StatusUnprocessableEntity,
	},
	{
		ID:          "server.repositories.builds.bad_settings",
		English:     "The build settings are not valid.",
		Description: "Build error when the tool, JDK version or arguments of a build or of the build settings are out of range.",
		Status:      http.StatusUnprocessableEntity,
	},
	{
		ID:          "server.repositories.builds.not_found",
		English:     "The build was not found.",
		Description: "Build error when no build with the requested number exists in the repository.",
		Status:      http.StatusNotFound,
	},
}
