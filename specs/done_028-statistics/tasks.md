---
description: "Task list for Feature 028: Statistics"
---

# Tasks: Statistics

**Input**: [spec.md](spec.md), [contracts/statistics-api.md](contracts/statistics-api.md), approved Penpot boards
**Tests**: new unit tests for the Prometheus client, the handlers and the rbac rule, plus web tests for components, pages and the server tab (MSW)
**Format**: [ID] [P?] Description

## Phase 1: API

- [X] T001 [P] `api/internal/prom`: client (instant and range queries, label quoting) with tests
- [X] T002 `api/internal/handlers/statistics.go`: four routes per the contract, with tests
- [X] T003 `api/internal/rbac/rbac.go`: `GET statistics → cluster:read`, with `TestAllow` cases
- [X] T004 `api/cmd/main.go`: `--prometheus-url` / `GAMEPLANE_PROMETHEUS_URL`; mount the routes

## Phase 2: Chart and docs

- [X] T005 [P] `charts/gameplane`: `metrics.prometheus.url` → `GAMEPLANE_PROMETHEUS_URL` (nil-safe under `--reuse-values`)
- [X] T006 [P] `docs/install.md` (values reference, Observability); `api/specs.md`; `netguard/specs.md`; `web/specs.md`

## Phase 3: Web

- [X] T007 [P] Theme tokens `--chart-inbound`, `--chart-outbound`, `--chart-players`; types; endpoints; MSW handlers and factories
- [X] T008 [P] `web/src/components/statistics/*`: line chart with hover, heatmap, split bar, live card, range select, inline meter
- [X] T009 `/statistics` page, router, sidebar item, breadcrumbs
- [X] T010 `/statistics/nodes/$name` page
- [X] T011 Server detail Statistics tab
- [X] T012 `npm run i18n:extract`; compile checks (`go build ./...`, `npx tsc --noEmit`)
