---
name: figma-design-first
description: "Use before writing code for a new dashboard or website screen, panel or modal, or a visual redesign of an existing one — design it in Figma through the figma-mcp-go MCP, get the user's approval on the frame, only then translate it to code."
---

# Figma-first design

Core rule 1. **In scope:** a new route, screen, panel, modal or drawer, and any change to an existing screen's visual layout. **Out of scope (stay code-first):** copy and label fixes, bug fixes, token swaps, logic or data changes, and anything outside `web/` and `website/`.

## 0. Connect

The design MCP is the local `figma-mcp-go` stdio server (`npx -y @vkhanhqui/figma-mcp-go@0.1.3`, registered as `figma-mcp-go`, tools `mcp__figma-mcp-go__*`). It uses no Figma API key: it reaches Figma only through its plugin over `ws://127.0.0.1:1994`.

- In Figma Desktop open the target file and run **Plugins → Development → Figma MCP Go** (imported once from `~/.figma-mcp-go/plugin/manifest.json`); it shows connected when the server is up.
- Keep the plugin open: tools act on the file and page where it runs (`get_pages`, `navigate_to_page` to switch pages).
- Tools missing or the plugin not connected → stop and ask the user; never fall back to another design tool or the official Figma MCP.

## 1. Design in Figma

Start with `get_metadata` and `get_pages`, then `get_design_context` (depth-limited) or `get_document` for the page tree. Build with the write tools (`create_frame`, `create_text`, `create_component`, `clone_node`, `set_auto_layout`, `set_fills`, `set_text`, `apply_style_to_node`, …).

- Reuse what exists: the Gameplane files (`Gameplane Dashboard`, `Gameplane — Assistant UI v2`) and their local components, styles and variables (`get_local_components`, `get_styles`, `get_variable_defs`). Start a new file only when no Gameplane file fits.
- Every colour comes from a style or variable that mirrors the repo's semantic tokens (`web/src/styles/globals.css`, website `website/src/styles/global.css`). No raw hex (core rule 2).
- Lay frames out with auto layout, not absolute positions, so the translation to code stays faithful.
- Cover light and dark, and a mobile width (core rule 1).
- `/login` and other unauthenticated frames show no cluster name, version or server count, and no account-existence wording (core rule 3).

## 2. Get approval — hard stop

- Export the frame as PNG with `get_screenshot` (or `save_screenshots` to disk); show the image, the file name and the frame name and node id.
- Ask with the question tool, and **write no code until the answer is yes**.
- Rejected or amended → iterate in Figma and export again. Never patch the design in code.

## 3. Translate to code

Read the approved frame with `get_node` / `get_design_context` (layout, spacing, fills, text styles) and `get_variable_defs` for its tokens, as a reference, never as code to paste.

- HeroUI v3 components and semantic tokens only (core rule 2); strict TS, no unjustified `any` (core rule 5).
- New dashboard screen: `web/src/routes/<name>.tsx` → register in `web/src/router/tree.tsx` → data through `web/src/lib/api.ts` + TanStack Query → `web/src/routes/<name>.test.tsx`.
- Website changes follow `website/`'s own CLAUDE.md and AGENTS.md.
- Verify locally with compile checks only (`npx tsc --noEmit`, core rule 8) plus a browser smoke test against `make web-dev`; CI runs the suites.
- Cite the Figma file name and frame node id in the PR body.
