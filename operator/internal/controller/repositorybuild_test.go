package controller

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

func TestParseBuildMarkers(t *testing.T) {
	log := `Downloading from central
::artifact:: target/LitHomes-1.0.0.jar 5662310 9f86d0aa
::artifact:: target/LitHomes-1.0.0-all.jar 100 abcd shaded
::published:: true
::cache:: 190840832
`
	artifacts, published, cacheBytes := ParseBuildMarkers(strings.NewReader(log))
	if !published {
		t.Fatalf("published = false, want true")
	}
	if cacheBytes != 190840832 {
		t.Fatalf("cacheBytes = %d, want 190840832", cacheBytes)
	}
	if len(artifacts) != 2 {
		t.Fatalf("len(artifacts) = %d, want 2", len(artifacts))
	}
	if artifacts[0].Path != "target/LitHomes-1.0.0.jar" || artifacts[0].Size != 5662310 || artifacts[0].SHA256 != "9f86d0aa" || artifacts[0].Shaded {
		t.Fatalf("artifacts[0] = %+v", artifacts[0])
	}
	if !artifacts[1].Shaded || artifacts[1].Size != 100 {
		t.Fatalf("artifacts[1] = %+v, want shaded size 100", artifacts[1])
	}
}

func TestParseBuildMarkersSkipsMalformedLines(t *testing.T) {
	log := "::artifact:: target/a.jar notanumber abc\n::artifact:: target/b.jar\n::published:: false\n"
	artifacts, published, cacheBytes := ParseBuildMarkers(strings.NewReader(log))
	if len(artifacts) != 0 || published || cacheBytes != 0 {
		t.Fatalf("got artifacts=%v published=%v cache=%d, want all zero", artifacts, published, cacheBytes)
	}
}

func TestRenderBuildScript(t *testing.T) {
	maven := renderBuildScript(gameplanev1alpha1.BuildToolMaven)
	for _, want := range []string{"set -eu", "mvn -s /etc/gameplane-build/settings.xml $BUILD_ARGS", "target/*.jar", "::published:: $published"} {
		if !strings.Contains(maven, want) {
			t.Errorf("maven script missing %q", want)
		}
	}
	if strings.Contains(maven, "gradlew") {
		t.Errorf("maven script must not reference gradlew")
	}

	gradle := renderBuildScript(gameplanev1alpha1.BuildToolGradle)
	for _, want := range []string{"if [ -f ./gradlew ]", "sh ./gradlew", "--init-script /etc/gameplane-build/gameplane.gradle", "build/libs/*.jar", "::cache:: "} {
		if !strings.Contains(gradle, want) {
			t.Errorf("gradle script missing %q", want)
		}
	}
	if strings.Contains(gradle, "mvn ") {
		t.Errorf("gradle script must not run mvn")
	}
}

func TestRenderMavenSettingsProfileOnlyWithRepository(t *testing.T) {
	if strings.Contains(renderMavenSettings(false), "<profiles>") {
		t.Errorf("settings without repository must not declare a profile")
	}
	withRepo := renderMavenSettings(true)
	if !strings.Contains(withRepo, "<activeProfile>gameplane</activeProfile>") || !strings.Contains(withRepo, "${env.GAMEPLANE_MAVEN_URL}/releases") {
		t.Errorf("settings with repository missing profile: %s", withRepo)
	}
}

func TestNewBuildJobWriteTokenOnlyWhenPublishing(t *testing.T) {
	r := &RepositoryBuildReconciler{MavenImage: "maven:3.9.11-eclipse-temurin-{jdk}", MavenURL: "http://gameplane-maven.test.svc:8080", Deadline: 1800}
	build := &gameplanev1alpha1.RepositoryBuild{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "lfln-build-1",
			Namespace: "games",
			Labels:    map[string]string{gameplanev1alpha1.RepositoryBuildNumberLabel: "1"},
		},
		Spec: gameplanev1alpha1.RepositoryBuildSpec{RepositoryRef: "lfln", Tool: gameplanev1alpha1.BuildToolMaven, JDK: 21, Publish: true},
	}

	job := r.newBuildJob(build, build.Name)
	if image := job.Spec.Template.Spec.Containers[0].Image; image != "maven:3.9.11-eclipse-temurin-21" {
		t.Fatalf("image = %q, want JDK substituted", image)
	}
	if !hasEnvVar(job.Spec.Template.Spec.Containers[0].Env, "GAMEPLANE_MAVEN_WRITE_TOKEN") {
		t.Fatalf("publishing build must expose the write token")
	}

	build.Spec.Publish = false
	job = r.newBuildJob(build, build.Name)
	if hasEnvVar(job.Spec.Template.Spec.Containers[0].Env, "GAMEPLANE_MAVEN_WRITE_TOKEN") {
		t.Fatalf("non-publishing build must not expose the write token")
	}
}

func hasEnvVar(env []corev1.EnvVar, name string) bool {
	for _, e := range env {
		if e.Name == name {
			return true
		}
	}
	return false
}
