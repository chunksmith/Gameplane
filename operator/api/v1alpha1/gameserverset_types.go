package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// GameServerSetMode selects how a GameServerSet runs its replicas.
// +kubebuilder:validation:Enum=Independent;StatefulSet
type GameServerSetMode string

// GameServerSet modes.
const (
	GameServerSetModeIndependent GameServerSetMode = "Independent"
	GameServerSetModeStatefulSet GameServerSetMode = "StatefulSet"
)

// ReplicaPlacement pins one StatefulSet ordinal to a node.
type ReplicaPlacement struct {
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=99
	Ordinal int32 `json:"ordinal"`

	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	Node string `json:"node"`
}

// ReplicaPort exposes basePort+ordinal on every replica through its own Service.
type ReplicaPort struct {
	// +kubebuilder:validation:Pattern=`^[a-z]([-a-z0-9]{0,13}[a-z0-9])?$`
	Name string `json:"name"`

	// +kubebuilder:validation:Enum=TCP;UDP
	// +kubebuilder:default=UDP
	// +optional
	Protocol corev1.Protocol `json:"protocol,omitempty"`

	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	BasePort int32 `json:"basePort"`

	// +kubebuilder:validation:MaxItems=16
	// +kubebuilder:validation:items:MaxLength=45
	// +optional
	ExternalIPs []string `json:"externalIPs,omitempty"`
}

// GameServerSetSpec is the desired state of a group of identical game servers.
// +kubebuilder:validation:XValidation:rule="self.mode == 'StatefulSet' || (!has(self.placement) && !has(self.replicaPorts) && !has(self.minReadySeconds))",message="placement, replicaPorts and minReadySeconds need mode StatefulSet"
// +kubebuilder:validation:XValidation:rule="!has(self.placement) || !has(self.template.storage) || !has(self.template.storage.ephemeral) || !self.template.storage.ephemeral",message="placement needs persistent storage"
// +kubebuilder:validation:XValidation:rule="!has(self.replicaPorts) || self.replicaPorts.all(p, p.basePort + self.replicas <= 65536)",message="replicaPorts basePort plus replicas must stay within 65535"
type GameServerSetSpec struct {
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=100
	// +kubebuilder:default=1
	// +optional
	Replicas int32 `json:"replicas"`

	// +kubebuilder:default=Independent
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="mode is immutable"
	// +optional
	Mode GameServerSetMode `json:"mode,omitempty"`

	// +kubebuilder:validation:MaxItems=64
	// +kubebuilder:validation:items:MaxLength=253
	// +optional
	Nodes []string `json:"nodes,omitempty"`

	// +listType=map
	// +listMapKey=ordinal
	// +kubebuilder:validation:MaxItems=100
	// +optional
	Placement []ReplicaPlacement `json:"placement,omitempty"`

	// +listType=map
	// +listMapKey=name
	// +kubebuilder:validation:MaxItems=8
	// +optional
	ReplicaPorts []ReplicaPort `json:"replicaPorts,omitempty"`

	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=3600
	// +optional
	MinReadySeconds int32 `json:"minReadySeconds,omitempty"`

	Template GameServerSpec `json:"template"`
}

// GameServerSetStatus is the observed state of a GameServerSet.
type GameServerSetStatus struct {
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// +optional
	Replicas int32 `json:"replicas"`
	// +optional
	ReadyReplicas int32 `json:"readyReplicas"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:shortName=gss
// +kubebuilder:subresource:status
// +kubebuilder:subresource:scale:specpath=.spec.replicas,statuspath=.status.replicas
// +kubebuilder:printcolumn:name="Template",type=string,JSONPath=`.spec.template.templateRef.name`
// +kubebuilder:printcolumn:name="Desired",type=integer,JSONPath=`.spec.replicas`
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// GameServerSet runs Replicas identical GameServers named <set>-<index>.
// +kubebuilder:validation:XValidation:rule="size(self.metadata.name) <= 40",message="name must be at most 40 characters"
type GameServerSet struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   GameServerSetSpec   `json:"spec"`
	Status GameServerSetStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// GameServerSetList is a list of GameServerSets.
type GameServerSetList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []GameServerSet `json:"items"`
}

func init() {
	SchemeBuilder.Register(&GameServerSet{}, &GameServerSetList{})
}
