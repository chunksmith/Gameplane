package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Repository build labels and annotations.
const (
	RepositoryLabel                = "gameplane.local/repository"
	RepositoryBuildNumberLabel     = "gameplane.local/build-number"
	RepositoryClearCacheAnnotation = "gameplane.local/clear-cache"
)

// BuildTool is the build tool of a repository build.
// +kubebuilder:validation:Enum=auto;maven;gradle
type BuildTool string

// BuildTool values.
const (
	BuildToolAuto   BuildTool = "auto"
	BuildToolMaven  BuildTool = "maven"
	BuildToolGradle BuildTool = "gradle"
)

// BuildPhase is the state of a repository build.
// +kubebuilder:validation:Enum=Queued;Pending;Running;Succeeded;Failed
type BuildPhase string

// BuildPhase values.
const (
	BuildPhaseQueued    BuildPhase = "Queued"
	BuildPhasePending   BuildPhase = "Pending"
	BuildPhaseRunning   BuildPhase = "Running"
	BuildPhaseSucceeded BuildPhase = "Succeeded"
	BuildPhaseFailed    BuildPhase = "Failed"
)

// RepositoryBuildSpec is the desired state of a RepositoryBuild.
type RepositoryBuildSpec struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="repositoryRef is immutable"
	RepositoryRef string `json:"repositoryRef"`

	// +kubebuilder:validation:Enum=auto;maven;gradle
	Tool BuildTool `json:"tool"`

	// +kubebuilder:validation:Enum=17;21;25
	JDK int32 `json:"jdk"`

	// +kubebuilder:validation:MaxLength=512
	// +optional
	Args string `json:"args,omitempty"`

	Publish bool `json:"publish"`

	// +optional
	Source BuildSource `json:"source,omitempty"`
}

// BuildSource is the working copy state a build started from.
type BuildSource struct {
	// +optional
	Commit string `json:"commit,omitempty"`

	// +optional
	Changes int32 `json:"changes,omitempty"`
}

// BuildArtifact is a jar a build produced.
type BuildArtifact struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`

	// +optional
	Shaded bool `json:"shaded,omitempty"`
}

// RepositoryBuildStatus is the observed state of a RepositoryBuild.
type RepositoryBuildStatus struct {
	// +optional
	Phase BuildPhase `json:"phase,omitempty"`

	// +optional
	Tool BuildTool `json:"tool,omitempty"`

	// +optional
	StartTime *metav1.Time `json:"startTime,omitempty"`

	// +optional
	CompletionTime *metav1.Time `json:"completionTime,omitempty"`

	// +optional
	Message string `json:"message,omitempty"`

	// +optional
	Artifacts []BuildArtifact `json:"artifacts,omitempty"`

	// +optional
	Published bool `json:"published,omitempty"`

	// +optional
	CacheBytes int64 `json:"cacheBytes,omitempty"`

	// +optional
	Resources corev1.ResourceRequirements `json:"resources,omitempty"`

	// +optional
	// +patchMergeKey=type
	// +patchStrategy=merge
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:shortName=rbuild
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Tool",type=string,JSONPath=`.spec.tool`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// RepositoryBuild is one sandboxed Maven or Gradle build of a Repository's working copy.
type RepositoryBuild struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   RepositoryBuildSpec   `json:"spec,omitempty"`
	Status RepositoryBuildStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// RepositoryBuildList is a list of RepositoryBuilds.
type RepositoryBuildList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []RepositoryBuild `json:"items"`
}

func init() {
	SchemeBuilder.Register(&RepositoryBuild{}, &RepositoryBuildList{})
}
