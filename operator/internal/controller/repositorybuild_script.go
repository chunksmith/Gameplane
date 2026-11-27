package controller

import (
	"strings"

	gameplanev1alpha1 "github.com/GameplanePanel/gameplane/operator/api/v1alpha1"
)

const buildScriptArtifacts = `main=""
main_shaded=""
for jar in @DIR@/*.jar; do
  [ -f "$jar" ] || continue
  name=$(basename "$jar")
  case "$name" in
    original-*|*-sources.jar|*-javadoc.jar|*-plain.jar) continue ;;
  esac
  shaded=""
  if [ -f "@DIR@/original-$name" ]; then shaded=" shaded"; fi
  echo "::artifact:: $jar $(wc -c < "$jar" | tr -d ' ') $(sha256sum "$jar" | cut -d' ' -f1)$shaded"
  if [ -z "$main" ] || { [ -n "$shaded" ] && [ -z "$main_shaded" ]; }; then
    main="$jar"
    main_shaded="$shaded"
  fi
done
`

const buildScriptMaven = `set -eu
cd /repo
mvn -s /etc/gameplane-build/settings.xml $BUILD_ARGS
`

const buildScriptMavenPublish = `published=false
if [ "${BUILD_PUBLISH:-}" = "true" ] && [ -n "${GAMEPLANE_MAVEN_URL:-}" ] && [ -n "${GAMEPLANE_MAVEN_WRITE_TOKEN:-}" ] && [ -n "$main" ]; then
  pom=pom.xml
  for reduced in dependency-reduced-pom.xml target/dependency-reduced-pom.xml; do
    if [ -f "$reduced" ]; then pom="$reduced"; fi
  done
  repository=releases
  case "$(basename "$main")" in *-SNAPSHOT*) repository=snapshots ;; esac
  if mvn -s /etc/gameplane-build/settings.xml -B deploy:deploy-file -Dfile="$main" -DpomFile="$pom" -DrepositoryId=gameplane-deploy -Durl="$GAMEPLANE_MAVEN_URL/$repository"; then
    published=true
  else
    echo "publish failed"
  fi
fi
`

const buildScriptGradle = `set -eu
cd /repo
gradle_cmd=gradle
if [ -f ./gradlew ]; then gradle_cmd="sh ./gradlew"; fi
$gradle_cmd --init-script /etc/gameplane-build/gameplane.gradle $BUILD_ARGS
`

const buildScriptGradlePublish = `published=false
if [ "${BUILD_PUBLISH:-}" = "true" ] && [ -n "${GAMEPLANE_MAVEN_URL:-}" ] && [ -n "${GAMEPLANE_MAVEN_WRITE_TOKEN:-}" ]; then
  if $gradle_cmd --init-script /etc/gameplane-build/gameplane.gradle publish; then
    published=true
  else
    echo "publish failed"
  fi
fi
`

const buildScriptFooter = `echo "::published:: $published"
echo "::cache:: $(du -sb /cache | cut -f1)"
`

func renderBuildScript(tool gameplanev1alpha1.BuildTool) string {
	if tool == gameplanev1alpha1.BuildToolGradle {
		return buildScriptGradle +
			strings.ReplaceAll(buildScriptArtifacts, "@DIR@", "build/libs") +
			buildScriptGradlePublish + buildScriptFooter
	}
	return buildScriptMaven +
		strings.ReplaceAll(buildScriptArtifacts, "@DIR@", "target") +
		buildScriptMavenPublish + buildScriptFooter
}

const mavenServersXML = `  <servers>
    <server>
      <id>gameplane</id>
      <username>${env.GAMEPLANE_MAVEN_USER}</username>
      <password>${env.GAMEPLANE_MAVEN_READ_TOKEN}</password>
    </server>
    <server>
      <id>gameplane-snapshots</id>
      <username>${env.GAMEPLANE_MAVEN_USER}</username>
      <password>${env.GAMEPLANE_MAVEN_READ_TOKEN}</password>
    </server>
    <server>
      <id>gameplane-deploy</id>
      <username>${env.GAMEPLANE_MAVEN_WRITE_USER}</username>
      <password>${env.GAMEPLANE_MAVEN_WRITE_TOKEN}</password>
    </server>
  </servers>
`

const mavenProfileXML = `  <mirrors>
    <mirror>
      <id>maven-default-http-blocker</id>
      <mirrorOf>external:http:*,!gameplane,!gameplane-snapshots</mirrorOf>
      <url>http://0.0.0.0/</url>
      <blocked>true</blocked>
    </mirror>
  </mirrors>
  <profiles>
    <profile>
      <id>gameplane</id>
      <repositories>
        <repository>
          <id>gameplane</id>
          <url>${env.GAMEPLANE_MAVEN_URL}/releases</url>
          <releases><enabled>true</enabled></releases>
          <snapshots><enabled>false</enabled></snapshots>
        </repository>
        <repository>
          <id>gameplane-snapshots</id>
          <url>${env.GAMEPLANE_MAVEN_URL}/snapshots</url>
          <releases><enabled>false</enabled></releases>
          <snapshots><enabled>true</enabled></snapshots>
        </repository>
      </repositories>
      <pluginRepositories>
        <pluginRepository>
          <id>gameplane</id>
          <url>${env.GAMEPLANE_MAVEN_URL}/releases</url>
          <releases><enabled>true</enabled></releases>
          <snapshots><enabled>false</enabled></snapshots>
        </pluginRepository>
        <pluginRepository>
          <id>gameplane-snapshots</id>
          <url>${env.GAMEPLANE_MAVEN_URL}/snapshots</url>
          <releases><enabled>false</enabled></releases>
          <snapshots><enabled>true</enabled></snapshots>
        </pluginRepository>
      </pluginRepositories>
    </profile>
  </profiles>
  <activeProfiles>
    <activeProfile>gameplane</activeProfile>
  </activeProfiles>
`

func renderMavenSettings(withRepository bool) string {
	settings := "<settings>\n" + mavenServersXML
	if withRepository {
		settings += mavenProfileXML
	}
	return settings + "</settings>\n"
}

const gradleInitGroovy = `def gameplaneUrl = System.getenv("GAMEPLANE_MAVEN_URL")
if (gameplaneUrl) {
    allprojects { project ->
        repositories {
            maven {
                url = "${gameplaneUrl}/releases"
                allowInsecureProtocol = true
                credentials {
                    username = System.getenv("GAMEPLANE_MAVEN_USER")
                    password = System.getenv("GAMEPLANE_MAVEN_READ_TOKEN")
                }
            }
            maven {
                url = "${gameplaneUrl}/snapshots"
                allowInsecureProtocol = true
                credentials {
                    username = System.getenv("GAMEPLANE_MAVEN_USER")
                    password = System.getenv("GAMEPLANE_MAVEN_READ_TOKEN")
                }
            }
        }
        plugins.withId("maven-publish") {
            publishing {
                repositories {
                    maven {
                        name = "gameplane"
                        url = project.version.toString().endsWith("SNAPSHOT") ? "${gameplaneUrl}/snapshots" : "${gameplaneUrl}/releases"
                        allowInsecureProtocol = true
                        credentials {
                            username = System.getenv("GAMEPLANE_MAVEN_WRITE_USER")
                            password = System.getenv("GAMEPLANE_MAVEN_WRITE_TOKEN")
                        }
                    }
                }
            }
        }
    }
}
`

func renderGradleInit() string {
	return gradleInitGroovy
}
