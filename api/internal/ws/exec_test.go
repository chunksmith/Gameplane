package ws

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	utilexec "k8s.io/client-go/util/exec"
)

func TestDecodeShell(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		command string
		timeout int
		wantErr bool
	}{
		{name: "valid", input: `{"command":"ls"}`, command: "ls"},
		{name: "timeout decoded", input: `{"command":"ls","timeoutSeconds":12}`, command: "ls", timeout: 12},
		{name: "blank command", input: `{"command":"   "}`, wantErr: true},
		{name: "oversized command", input: `{"command":"` + strings.Repeat("a", 8<<10+1) + `"}`, wantErr: true},
		{name: "not json", input: "not json", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body, err := decodeShell(strings.NewReader(test.input))
			if (err != nil) != test.wantErr {
				t.Fatalf("decodeShell() error = %v, wantErr %v", err, test.wantErr)
			}
			if test.wantErr {
				return
			}
			if body.Command != test.command || body.TimeoutSeconds != test.timeout {
				t.Fatalf("decodeShell() = %+v, want command %q timeout %d", body, test.command, test.timeout)
			}
		})
	}
}

func TestShellTimeout(t *testing.T) {
	tests := map[int]time.Duration{
		0:   30 * time.Second,
		-5:  30 * time.Second,
		10:  10 * time.Second,
		999: 55 * time.Second,
	}
	for seconds, want := range tests {
		if got := shellTimeout(seconds); got != want {
			t.Fatalf("shellTimeout(%d) = %v, want %v", seconds, got, want)
		}
	}
}

func TestDataMountPath(t *testing.T) {
	withGame := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{
		{Name: "agent", VolumeMounts: []corev1.VolumeMount{{Name: "data", MountPath: "/agent"}}},
		{Name: "game", VolumeMounts: []corev1.VolumeMount{{Name: "cfg", MountPath: "/cfg"}, {Name: "data", MountPath: "/srv/game"}}},
	}}}
	if got := dataMountPath(withGame); got != "/srv/game" {
		t.Fatalf("dataMountPath() = %q, want /srv/game", got)
	}
	noGame := &corev1.Pod{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "agent"}}}}
	if got := dataMountPath(noGame); got != "/data" {
		t.Fatalf("dataMountPath() = %q, want /data", got)
	}
}

func TestCappedBuffer(t *testing.T) {
	buffer := &cappedBuffer{limit: 5}
	if n, err := buffer.Write([]byte("abc")); n != 3 || err != nil {
		t.Fatalf("first Write() = %d, %v", n, err)
	}
	if n, err := buffer.Write([]byte("defgh")); n != 5 || err != nil {
		t.Fatalf("second Write() = %d, %v", n, err)
	}
	if got := buffer.String(); got != "abcde" {
		t.Fatalf("String() = %q, want abcde", got)
	}
	if !buffer.truncated {
		t.Fatal("expected truncated buffer")
	}

	exact := &cappedBuffer{limit: 5}
	exact.Write([]byte("abcde"))
	if exact.truncated {
		t.Fatal("exact-fit buffer must not be truncated")
	}
}

func TestShellResult(t *testing.T) {
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "n"}}

	out, err := shellResult(context.Background(), shellResponse{}, nil, pod)
	if err != nil || out.ExitCode != 0 {
		t.Fatalf("nil err = %+v, %v", out, err)
	}

	exitErr := utilexec.CodeExitError{Err: errors.New("x"), Code: 2}
	out, err = shellResult(context.Background(), shellResponse{}, exitErr, pod)
	if err != nil || out.ExitCode != 2 {
		t.Fatalf("exit err = %+v, %v", out, err)
	}

	past, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	out, err = shellResult(past, shellResponse{}, errors.New("stream closed"), pod)
	if err != nil || out.ExitCode != 124 || !strings.Contains(out.Stderr, "timed out") {
		t.Fatalf("timeout = %+v, %v", out, err)
	}

	out, err = shellResult(context.Background(), shellResponse{}, errors.New("boom"), pod)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("plain err = %+v, %v", out, err)
	}
}

func TestClipRunes(t *testing.T) {
	tests := []struct {
		text  string
		limit int
		want  string
	}{
		{"abc", 2, "ab"},
		{"ğüş", 2, "ğü"},
		{"ab", 5, "ab"},
	}
	for _, test := range tests {
		if got := clipRunes(test.text, test.limit); got != test.want {
			t.Fatalf("clipRunes(%q, %d) = %q, want %q", test.text, test.limit, got, test.want)
		}
	}
}
