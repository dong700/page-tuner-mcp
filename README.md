# page-tuner

**AI writes the page. You polish it by hand. The rest goes back to AI.**

A human-in-the-loop HTML editor exposed as a [Model Context Protocol](https://modelcontextprotocol.io) server.
No screenshot, no vision model, no pixel guessing — both sides edit the same single-file HTML at the source level.

![Python](https://img.shields.io/badge/python-3.9%2B-blue)
![MCP](https://img.shields.io/badge/MCP-stdio-16a34a)
![Tools](https://img.shields.io/badge/tools-12-6366f1)
![License](https://img.shields.io/badge/license-MIT-black)

![demo](docs/demo.gif)

---

## Why this exists

An agent can generate a decent landing page, pricing page or checkout flow in seconds. The last 10% is the hard part:

- “make the cards breathe more” is a feeling, not a prompt — typing it out costs more than dragging a slider;
- deleting one duplicate button, nudging a badge 4px, softening a hover shadow — these are one-gesture decisions;
- and after a human edits the file, the agent has no idea what changed, so it happily re-adds the button you just deleted.

`page-tuner` closes that loop:

1. Agent writes the page, then starts a **local visual editor** and hands the URL to the human.
2. Human edits by hand — select, restyle, hover state, drag order, delete, polish whole page.
3. Every edit is recorded in a structured change log (`<page>.changes.json`).
4. Human lassos the block that still looks wrong, picks an intent (style / copy / add / hand-it-all-over) and writes one sentence.
5. Agent reads the change log **first** (review step), then the lassoed ids + intent, edits the same file, and the editor syncs back within ~1s.

---

## Quick start

Requirements: Python 3.9+. **Zero third-party dependencies.**

```bash
git clone https://github.com/dong700/page-tuner-mcp.git
cd page-tuner-mcp
```

Add a stdio server to your MCP client (Claude Desktop, Cursor, Trae, Cline, …):

```json
{
  "mcpServers": {
    "page-tuner": {
      "command": "python",
      "args": ["/abs/path/to/page-tuner-mcp/mcp_server.py"]
    }
  }
}
```

On Windows use double backslashes, e.g. `"C:\\tools\\page-tuner-mcp\\mcp_server.py"`. A ready-made file lives in [`mcp.example.json`](mcp.example.json).

Ask the agent:

> Build me a single-file landing page, then open it in page-tuner and give me the URL.

### Use as an agent skill

The same loop is packaged as a portable Agent Skill: [`skill/page-tuner/SKILL.md`](skill/page-tuner/SKILL.md). Build the upload zip with:

```bash
python scripts/package_skill.py
```

Packaging and marketplace notes: [docs/skill-packaging.zh-CN.md](docs/skill-packaging.zh-CN.md) (中文).

---

## The workflow

```
Agent writes HTML
   │
   ├─ html_editor(start, file)          → returns a local URL, hand it to the human
   ▼
Human: select / restyle / hover & active / drag order / polish / lasso a block + intent + note
   │        every gesture lands in <page>.changes.json (debounced 400ms)
   │        "Save for agent" also writes <page>.selection.json
   ▼
Agent: html_changes(file)               ← review what the human actually changed
   │        conflicts / duplicates / accidental deletions → fix them
   ├─ html_selection(file)              ← lassoed ids + intent + note
   │
   ├─ html_style / html_text / html_insert / html_delete / html_move
   │        editor auto-syncs (~1.2s), keeps selection and scroll position
   ▼
Human keeps polishing → save / export
   │
   └─ html_clean(file)                  ← strip internal ids before delivery
```

Each half works alone: pure MCP editing works without the UI; pure manual editing works without AI.

---

## Tools (12)

| Tool | What it does | Key args |
|---|---|---|
| `html_editor` | start / status / stop the local visual editor | `action`, `file`, `port?` |
| `html_outline` | tree of editable elements with stable ids | `max_depth`, `limit` |
| `html_find` | locate elements by tag / class / text | `tag`, `cls`, `text` |
| `html_inspect` | opening tag, direct text, children, parent | `id` |
| `html_style` | set inline CSS, batch across ids; empty string removes a property | `ids[]`, `props{}` |
| `html_text` | edit a leaf element's text (containers are rejected with children listed) | `id`, `text` |
| `html_move` | reorder within the same parent | `direction: up\|down\|before\|after` |
| `html_insert` | insert HTML before / after / inside an element; returns new ids | `id`, `position`, `html` |
| `html_delete` | delete an element including its indentation | `id` |
| `html_clean` | strip `data-ct-id` and empty `style=""` before delivery | `file` |
| `html_changes` | read the human's edit journal (style / size / text / move / delete / reset / polish) | `file`, `clear?`, `limit?` |
| `html_selection` | read the human's lasso: ids, intent, note | `file`, `clear?` |

Failures return compact JSON with `error` + `hint` (+ `near` ids) so the model can recover without re-reading the file.

---

## What the human gets

- Select anything: font size / weight / line-height / align / color / background / radius / padding / width / opacity
- Three states: base, `:hover` (live preview while editing), `:active`
- Presets: 6 gradients, 5 shadows, 5 hover effects (lift / scale / glow / bright)
- Drag to reorder (with insertion line), drag to offset, arrow-key nudging (Shift ×10)
- One-click typographic polish: type scale, line-height, 4px spacing grid, radius normalization
- Browse mode: clicks are real interactions (add-to-cart, navigation) with the blue selection frame hidden
- Capture click state: records transient text/style changes and revert timing
- Delete / reset / select parent / jump between parent-child chips
- Multi-page: switch pages from the top bar, double-click in-site links to jump
- **Any UI control can be deleted without crashing the editor** (tolerant event binding)

---

## How it works

- **Source-level surgery.** `htmlops.py` finds tag positions and rewrites only the affected slice; untouched bytes stay byte-identical.
- **Two style layers.** Geometry (font-size, padding, width, offsets) goes inline. Visual properties (color, background, gradient, opacity, shadow, radius, transform) go into a unique `.pt-N` class inside one `<style data-pt>` block — inline CSS cannot express `:hover`.
- **Stable ids.** `data-ct-id="eN"` is injected on both sides by DOM order, with a two-pass scan to avoid collisions.
- **Edit journal.** Every human action becomes a typed record (`style` / `geometry` / `text` / `move` / `delete` / `reset` / `layout`) with element id, props, before/after text, or delta. Debounced into a sidecar JSON the agent can read in one tool call.
- **No browser on the MCP side.** The server never needs a headless browser; pixel-level operations (hover preview, polish) happen only in the human's editor.
- **Localhost only.** The editor binds `127.0.0.1`; it is not a remote service and never touches files outside the page you opened.

Repository layout:

```
page-tuner/
├─ mcp_server.py      MCP stdio server (12 tools)
├─ htmlops.py         source-level parser / patcher
├─ server.py          visual editor backend (default port 8766)
├─ static/            editor UI: index.html, editor.js, inject.js, style.css
├─ sample/landing.html
├─ docs/demo.gif
└─ mcp.example.json
```

---

## Limits

- Single-file static HTML only (styles, scripts, images inlined). Build-tool projects are out of scope.
- No free-form drag to arbitrary coordinates — document flow would collapse. Use offsets or spacing instead.
- Transient states implemented in page JS (text swap + `setTimeout` revert) cannot be changed via CSS; lasso it and hand it to the agent.
- Exported `blob:` preview has no backend; API-driven pages should be viewed on their own server.

---

## 中文文档

[README.zh-CN.md](README.zh-CN.md) — 完整中文说明、设计约定与排错。

## Blog

[让前端再死一次：个人开发者怎么做出自己真正满意的页面](docs/blog/why-frontend-dies.zh-CN.md)

## License

MIT
