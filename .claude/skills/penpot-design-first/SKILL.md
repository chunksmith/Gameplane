---
name: penpot-design-first
description: "Use before writing code for a new dashboard or website screen, panel or modal, or a visual redesign of an existing one — design it in Penpot through the Penpot MCP, get the user's approval on the board, only then translate it to code."
---

# Penpot-first design

Core rule 1. **In scope:** a new route, screen, panel, modal or drawer, and any change to an existing screen's visual layout. **Out of scope (stay code-first):** copy and label fixes, bug fixes, token swaps, logic or data changes, and anything outside `web/` and `website/`.

## 0. Connect

The Penpot MCP is the local `@penpot/mcp` server (`http://localhost:4401/mcp`, registered as `penpot`), and it reaches Penpot only through its plugin.

- Open the target file on design.penpot.app in the user's regular browser (the desktop app's built-in browser pane blocks `localhost`, so the plugin cannot load there); load the plugin from `http://localhost:4400/manifest.json` (Plugins, ⌘⌥P → Install) the first time, then open it and click **Connect to MCP server**.
- Keep the plugin open and the Penpot tab focused: the MCP acts only on the focused page of that file.
- Tools missing or `localhost:4401` down → stop and ask the user; never fall back to another design tool.

## 1. Design in Penpot

Call `high_level_overview` first and `penpot_api_info` for any API you are unsure of; build with `execute_code` (Penpot Plugin API).

- Reuse what exists: the Gameplane files (`Gameplane Dashboard`, `Gameplane — Assistant UI v2`, imported from Figma) and their library components, colours and typographies (`penpot.library.local`). Start a new file only when no Gameplane file fits.
- Every colour comes from a library colour or token that mirrors the repo's semantic tokens (`web/src/styles/globals.css`, website `website/src/styles/global.css`). No raw hex (core rule 2).
- Lay boards out with flex/grid layout, not absolute positions, so the translation to code stays faithful.
- Cover light and dark, and a mobile width (core rule 1).
- `/login` and other unauthenticated boards show no cluster name, version or server count, and no account-existence wording (core rule 3).

## 2. Get approval — hard stop

- `export_shape` the board as PNG; show the image, the Penpot file link and the board name and id.
- Ask with the question tool, and **write no code until the answer is yes**.
- Rejected or amended → iterate in Penpot and export again. Never patch the design in code.

## 3. Translate to code

Read the approved board with `execute_code`: its tree (layout, spacing, fills, text styles) and `penpot.generateStyle(shapes, { type: 'css' })` / `penpot.generateMarkup(shapes, { type: 'html' })` as a reference, never as code to paste.

- HeroUI v3 components and semantic tokens only (core rule 2); strict TS, no unjustified `any` (core rule 5).
- New dashboard screen: `web/src/routes/<name>.tsx` → register in `web/src/router/tree.tsx` → data through `web/src/lib/api.ts` + TanStack Query → `web/src/routes/<name>.test.tsx`.
- Website changes follow `website/`'s own CLAUDE.md and AGENTS.md.
- Verify locally with compile checks only (`npx tsc --noEmit`, core rule 8) plus a browser smoke test against `make web-dev`; CI runs the suites.
- Cite the Penpot file link and board id in the PR body.
