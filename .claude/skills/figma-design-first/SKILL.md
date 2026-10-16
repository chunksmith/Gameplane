---
name: figma-design-first
description: "Use before writing code for a new dashboard or website screen, panel or modal, or a visual redesign of an existing one — design it in Figma through the Figma MCP, get the user's approval on the frame, only then translate it to code."
---

# Figma-first design

Core rule 1. **In scope:** a new route, screen, panel, modal or drawer, and any change to an existing screen's visual layout. **Out of scope (stay code-first):** copy and label fixes, bug fixes, token swaps, logic or data changes, and anything outside `web/` and `website/`.

## 1. Design in Figma

Load `figma:figma-use` (mandatory before every `use_figma` call) and `figma:figma-generate-design` before touching the file.

- Reuse what exists: `search_design_system` and `get_variable_defs` for components and variables already in the file; `figma:figma-create-new-file` only when there is no file yet.
- Bind every colour and spacing to a variable that maps to the repo's semantic tokens (`web/src/styles/globals.css`, website `website/src/styles/global.css`). No raw hex (core rule 2).
- Cover light and dark, and a mobile width (core rule 1).
- `/login` and other unauthenticated frames show no cluster name, version or server count, and no account-existence wording (core rule 3).

## 2. Get approval — hard stop

- `get_screenshot` the frame; show the screenshot, the Figma link and the node id.
- Ask with the question tool, and **write no code until the answer is yes**.
- Rejected or amended → iterate in Figma and screenshot again. Never patch the design in code.

## 3. Translate to code

Load `figma:figma-design-to-code`, then `get_design_context` on the approved node.

- HeroUI v3 components and semantic tokens only (core rule 2); strict TS, no unjustified `any` (core rule 5).
- New dashboard screen: `web/src/routes/<name>.tsx` → register in `web/src/router/tree.tsx` → data through `web/src/lib/api.ts` + TanStack Query → `web/src/routes/<name>.test.tsx`.
- Website changes follow `website/`'s own CLAUDE.md and AGENTS.md.
- Verify locally with compile checks only (`npx tsc --noEmit`, core rule 8) plus a browser smoke test against `make web-dev`; CI runs the suites.
- Cite the Figma link and node id in the PR body.
