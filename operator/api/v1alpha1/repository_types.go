package v1alpha1

import (
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// RepositoryPhase is a high-level state for a Repository's working copy.
// +kubebuilder:validation:Enum=Pending;Cloning;Ready;Failed
type RepositoryPhase string

// RepositoryPhase constants define the possible values for a Repository's phase.
const (
	RepositoryPhasePending RepositoryPhase = "Pending"
	RepositoryPhaseCloning RepositoryPhase = "Cloning"
	RepositoryPhaseReady   RepositoryPhase = "Ready"
	RepositoryPhaseFailed  RepositoryPhase = "Failed"
)

// RepositoryStorage sizes the PVC holding the shared working copy.
type RepositoryStorage struct {
	// +optional
	Size resource.Quantity `json:"size,omitempty"`

	// +optional
	StorageClassName *string `json:"storageClassName,omitempty"`
}

// RepositorySpec is the desired state of a Repository.
type RepositorySpec struct {
	// +kubebuilder:validation:Pattern=`^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`
	// +kubebuilder:validation:MaxLength=512
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="url is immutable"
	URL string `json:"url"`

	// +kubebuilder:validation:MaxLength=255
	// +optional
	Branch string `json:"branch,omitempty"`

	// +optional
	Storage RepositoryStorage `json:"storage,omitempty"`
}

// RepositoryStatus is the observed state of a Repository.
type RepositoryStatus struct {
	// +optional
	Phase RepositoryPhase `json:"phase,omitempty"`

	// +optional
	Head string `json:"head,omitempty"`

	// +optional
	Branch string `json:"branch,omitempty"`

	// +optional
	Ahead int32 `json:"ahead,omitempty"`

	// +optional
	Behind int32 `json:"behind,omitempty"`

	// +optional
	Dirty bool `json:"dirty,omitempty"`

	// +optional
	LastFetch *metav1.Time `json:"lastFetch,omitempty"`

	// +optional
	// +patchMergeKey=type
	// +patchStrategy=merge
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:shortName=repo;repos
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="URL",type=string,JSONPath=`.spec.url`
// +kubebuilder:printcolumn:name="Branch",type=string,JSONPath=`.status.branch`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
// +kubebuilder:validation:XValidation:rule="size(self.metadata.name) <= 52",message="repository names must be at most 52 characters"

// Repository is a GitHub repository whose shared working copy lives on a PVC
// served by a repo agent pod. Ownership, collaborators and network use the
// same gameplane.local/owner-id, owner, collaborators and network annotations
// as GameServer.
type Repository struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   RepositorySpec   `json:"spec,omitempty"`
	Status RepositoryStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// RepositoryList is a list of Repositories.
type RepositoryList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Repository `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Repository{}, &RepositoryList{})
}
