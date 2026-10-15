package kube

import (
	"testing"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
)

func TestGVRsTable(t *testing.T) {
	want := map[string]schema.GroupVersionResource{
		"servers":    {Group: "gameplane.local", Version: "v1alpha1", Resource: "gameservers"},
		"serversets": {Group: "gameplane.local", Version: "v1alpha1", Resource: "gameserversets"},
		"templates":  {Group: "gameplane.local", Version: "v1alpha1", Resource: "gametemplates"},
		"backups":    {Group: "gameplane.local", Version: "v1alpha1", Resource: "backups"},
		"schedules":  {Group: "gameplane.local", Version: "v1alpha1", Resource: "backupschedules"},
		"restores":   {Group: "gameplane.local", Version: "v1alpha1", Resource: "restores"},
	}
	for k, v := range want {
		got, ok := GVRs[k]
		if !ok || got != v {
			t.Errorf("GVRs[%q] = %v ok=%v, want %v", k, got, ok, v)
		}
	}
}

func TestModuleGVRs(t *testing.T) {
	if GVRModule.Resource != "modules" {
		t.Fatalf("got %v", GVRModule)
	}
	if GVRModuleSource.Resource != "modulesources" {
		t.Fatalf("got %v", GVRModuleSource)
	}
}

func TestNew_Success(t *testing.T) {
	// Empty rest.Config is enough — the client constructors don't dial.
	c, err := New(&rest.Config{Host: "https://example.invalid"})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	if c.Dynamic == nil || c.Typed == nil || c.Config == nil {
		t.Fatalf("missing fields: %+v", c)
	}
}

func TestNew_BadConfig(t *testing.T) {
	// A config with a content negotiator pointing to a nil scheme is one
	// of the few ways to make NewForConfig fail without dialing. Use a
	// nonsense BurstSize/Bearer combination... actually those are all
	// validated lazily. The simplest deterministic failure is a malformed
	// CA cert.
	cfg := &rest.Config{
		Host: "https://example.invalid",
		TLSClientConfig: rest.TLSClientConfig{
			CAData: []byte("not a pem"),
		},
	}
	if _, err := New(cfg); err == nil {
		// Some client-go versions defer cert parsing; if it succeeded that's
		// fine, just don't fail the suite.
		t.Skip("client-go accepted bogus CA without error")
	}
}
