//go:build e2e

package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

const repoGitFixture = `apiVersion: v1
kind: Namespace
metadata:
  name: %[1]s
---
apiVersion: v1
kind: Pod
metadata:
  name: e2e-repositories-git
  namespace: %[1]s
  labels: { app: e2e-repositories-git }
spec:
  containers:
    - name: git
      image: buildpack-deps:bookworm-scm
      command: ["sh", "-c"]
      args:
        - |
          set -e
          git config --global user.name seed
          git config --global user.email seed@example.com
          git init -q --bare -b main /srv/e2e.git
          git clone -q /srv/e2e.git /tmp/seed
          cd /tmp/seed
          echo seed > README.md
          git add README.md
          git commit -qm seed
          git push -q origin HEAD:main
          exec git daemon --reuseaddr --export-all --enable=receive-pack --base-path=/srv --listen=0.0.0.0 --port=9418 /srv
      ports: [{ containerPort: 9418 }]
      readinessProbe: { tcpSocket: { port: 9418 }, periodSeconds: 2 }
---
apiVersion: v1
kind: Service
metadata:
  name: e2e-repositories-git
  namespace: %[1]s
spec:
  selector: { app: e2e-repositories-git }
  ports: [{ port: 9418 }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: e2e-repositories-git-egress
  namespace: %[2]s
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/name: gameplane-repo, app.kubernetes.io/instance: %[3]s }
  policyTypes: [Egress]
  egress:
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: %[1]s } } }]
      ports: [{ protocol: TCP, port: 9418 }]
`

func TestAPI_RepositoryCommitPush(t *testing.T) {
	t.Parallel()

	ns := "gameplane-games"
	gitNS := "e2e-repositories-git"
	repo := "e2e-repositories-repo"
	remote := "https://github.com/e2e-gameplane/" + repo
	query := "?namespace=" + ns

	envInstance.BootstrapAdmin(t, adminUsername, adminPassword)
	cli := envInstance.APIClient(t, adminUsername, adminPassword)
	defer cli.Close()

	meResp, me, err := cli.Get("/users/me")
	if err != nil {
		t.Fatalf("GET /users/me: %v", err)
	}
	_ = meResp.Body.Close()
	tokenSecret := "gameplane-github-" + extractID(string(me))
	secret := `apiVersion: v1
kind: Secret
metadata:
  name: ` + tokenSecret + `
  namespace: gameplane-system
  labels: { gameplane.local/github-token: "true" }
stringData: { token: e2e-token, login: e2e-bot, name: E2E Bot, id: "1" }
`
	if out, err := envInstance.KubectlWithStdin(t.Context(), secret, "apply", "-f", "-"); err != nil {
		t.Fatalf("apply token secret: %v\n%s", err, out)
	}
	fixture := fmt.Sprintf(repoGitFixture, gitNS, ns, repo)
	if out, err := envInstance.KubectlWithStdin(t.Context(), fixture, "apply", "-f", "-"); err != nil {
		t.Fatalf("apply git fixture: %v\n%s", err, out)
	}
	t.Cleanup(func() {
		if delResp, _, err := cli.Delete("/repositories/" + repo + query); err == nil {
			_ = delResp.Body.Close()
		}
		ctx := context.Background()
		_, _ = envInstance.Kubectl(ctx, "delete", "--ignore-not-found", "-n", "gameplane-system", "secret", tokenSecret)
		_, _ = envInstance.Kubectl(ctx, "delete", "--ignore-not-found", "-n", ns, "networkpolicy", "e2e-repositories-git-egress")
		_, _ = envInstance.Kubectl(ctx, "delete", "--ignore-not-found", "--wait=false", "namespace", gitNS)
	})
	if out, err := envInstance.Kubectl(t.Context(), "wait", "-n", gitNS, "--for=condition=Ready", "pod/e2e-repositories-git", "--timeout=300s"); err != nil {
		t.Fatalf("git fixture not ready: %v\n%s", err, out)
	}

	resp, body, err := cli.Post("/repositories"+query, map[string]string{"url": remote, "branch": "main", "name": repo})
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create repository: %v %d %s", err, statusOf(resp), body)
	}
	requireAgentReady(t, ns, repo)
	gitBase := "url.git://e2e-repositories-git." + gitNS + ".svc.cluster.local/e2e.git"
	insteadOf := gitBase + ".insteadOf"
	pushInsteadOf := gitBase + ".pushInsteadOf"
	if out, err := envInstance.KubectlExec(t, ns, repo+"-0", "git", "config", "--global", insteadOf, remote); err != nil {
		t.Fatalf("rewrite remote: %v\n%s", err, out)
	}

	envInstance.Eventually(t, 3*time.Minute, func() (bool, string) {
		resp, body, err := cli.Get("/repositories/" + repo + query)
		if err != nil {
			return false, err.Error()
		}
		_ = resp.Body.Close()
		var state struct {
			Phase string  `json:"phase"`
			Error *string `json:"error"`
		}
		_ = json.Unmarshal(body, &state)
		if state.Phase == "Failed" {
			t.Fatalf("clone failed: %s", body)
		}
		return resp.StatusCode == http.StatusOK && state.Phase == "Ready", string(body)
	})
	if out, err := envInstance.KubectlExec(t, ns, repo+"-0", "git", "config", "--global", "--unset", insteadOf); err != nil {
		t.Fatalf("unset fetch rewrite: %v\n%s", err, out)
	}
	if out, err := envInstance.KubectlExec(t, ns, repo+"-0", "git", "config", "--global", pushInsteadOf, remote); err != nil {
		t.Fatalf("rewrite push remote: %v\n%s", err, out)
	}

	base := "/repositories/" + repo
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, cli.BaseURL+base+"/files/write"+query+"&path="+url.QueryEscape("/e2e.txt"), strings.NewReader("from e2e\n"))
	if err != nil {
		t.Fatalf("build write: %v", err)
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Gameplane-CSRF", cli.CSRF)
	writeResp, err := cli.HTTP.Do(req)
	if err != nil {
		t.Fatalf("write file: %v", err)
	}
	writeBody, _ := io.ReadAll(writeResp.Body)
	_ = writeResp.Body.Close()
	if writeResp.StatusCode/100 != 2 {
		t.Fatalf("write file: %d %s", writeResp.StatusCode, writeBody)
	}

	stageResp, stageBody, err := cli.Post(base+"/git/stage"+query, map[string]any{"paths": "all"})
	if stageResp != nil {
		_ = stageResp.Body.Close()
	}
	if err != nil || stageResp.StatusCode != http.StatusOK {
		t.Fatalf("stage: %v %d %s", err, statusOf(stageResp), stageBody)
	}
	resp, body, err = cli.Post(base+"/git/commit"+query, map[string]any{"summary": "e2e commit", "push": true})
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil || resp.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"pushed":true`)) {
		t.Fatalf("commit and push: %v %d %s", err, statusOf(resp), body)
	}

	out, err := envInstance.KubectlExec(t, gitNS, "e2e-repositories-git", "git", "--git-dir=/srv/e2e.git", "log", "-1", "--format=%s %ae", "main")
	if err != nil || strings.TrimSpace(out) != "e2e commit 1+e2e-bot@users.noreply.github.com" {
		t.Fatalf("fixture head = %q (%v)", out, err)
	}
	if out, err := envInstance.KubectlExec(t, gitNS, "e2e-repositories-git", "git", "--git-dir=/srv/e2e.git", "show", "main:e2e.txt"); err != nil || out != "from e2e\n" {
		t.Fatalf("fixture file = %q (%v)", out, err)
	}
}

func statusOf(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}
