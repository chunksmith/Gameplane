FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
WORKDIR /src

# netguard, gameaction, gp-module, and telemetryschema are in-repo modules the API depends
# on via local replaces (../netguard, ../gameaction, ../gp-module, ../telemetryschema);
# copy them first so `go mod download` and the build resolve them.
COPY netguard/ ./netguard/
COPY gameaction/ ./gameaction/
COPY gp-module/ ./gp-module/
COPY telemetryschema/ ./telemetryschema/
COPY api/go.mod api/go.sum* ./api/
WORKDIR /src/api
RUN go mod download

WORKDIR /src
COPY api/ ./api/
WORKDIR /src/api

ARG VERSION=dev
# modernc sqlite is pure Go, no CGO required.
# Cross-compile on the build host ($BUILDPLATFORM above) rather than under
# QEMU emulation: multi-arch release builds of the arm64 image were slow
# enough to hit the release job timeout.
ARG TARGETARCH
# Build tags: "postgres" for the e2e-postgres image; empty by default so the release build is unchanged.
ARG GO_TAGS=""
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
    -tags "${GO_TAGS}" \
    -trimpath \
    -ldflags="-s -w -X main.Version=${VERSION}" \
    -o /out/api ./cmd

RUN mkdir -p /out/data /out/keys && chmod 0700 /out/keys && chown 65532:65532 /out/data /out/keys

FROM buildpack-deps:trixie-curl AS claude
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG CLAUDE_CODE_VERSION=2.1.301
ARG KUBECTL_VERSION=1.37.1
ARG TARGETARCH
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
    && cp -L /root/.local/bin/claude /claude \
    && curl -fsSLo /kubectl "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" \
    && echo "$(curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256")  /kubectl" | sha256sum -c - \
    && chmod 0755 /kubectl

FROM debian:trixie-slim
RUN useradd --no-log-init --uid 65532 --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin nonroot
WORKDIR /
COPY --from=build /out/api /api
COPY --from=claude /claude /usr/local/bin/claude
COPY --from=claude /kubectl /usr/local/bin/kubectl
COPY --from=claude /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# Seed named Docker volumes with a directory writable by the runtime user.
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=build --chown=65532:65532 /out/keys /keys
USER 65532:65532
EXPOSE 8000
VOLUME ["/data"]
ENTRYPOINT ["/api"]
