---
name: page-tuner
description: Human-in-the-loop polishing for single-file HTML pages. Starts a local visual editor so the user can restyle, reorder, delete and lasso problem areas by hand, then reads their edit journal and lassoed intent through the page-tuner MCP and applies source-level changes. Use when the user wants to refine a generated landing page, pricing page, checkout flow or any static HTML, complains about spacing, colors, radius, copy or layout, asks to add or remove a section, or says things like "let me tweak it myself", "这块不对", "圈一下交给你".
license: MIT
compatibility: Requires Python 3.9+ and the page-tuner MCP server configured in the client (github.com/dong700/page-tuner-mcp). Single-file static HTML only; no build tools, no third-party Python packages.
metadata:
  author: dong700
  version: "1.6.0"
  repository: https://github.com/dong700/page-tuner-mcp
---

# page-tuner

Give the human a real editor for the last 10% of a generated page, then take over the parts they hand back.

The page-tuner MCP edits HTML at the source level (no regeneration), and the editor the human uses writes two sidecar files next to the page:

- `<page>.changes.json` — every hand edit (style / size / copy / move / delete / reset / polish)
- `<page>.selection.json` — the lassoed area, the intent, and the user's own sentence

## Before you start

1. The target must be a **single-file static HTML** page (styles, scripts, images inlined). If the project uses a bundler, say so and stop.
2. Confirm the page-tuner MCP tools are available. If `html_outline` is unknown, do **not** try to install anything silently — give the user this config and stop:

   ```json
   {"mcpServers":{"page-tuner":{"command":"python","args":["/abs/path/to/page-tuner-mcp/mcp_server.py"]}}}
   ```

   Repository: https://github.com/dong700/page-tuner-mcp
3. Use an absolute file path. Never touch any file the user did not point at.

## The loop

### 1. Open the editor

Call `html_editor` with `action: "start"` and the absolute `file` path.

Return the `url` **verbatim** and tell the user what they can do there:

> 打开这个地址自己改：点选元素调样式/悬停/按下、拖顺序、一键排版、删元素；改不动的就圈住那块，选个意图写一句人话，点「存给 agent」。

Then end your turn. Do not poll, do not keep editing the file while they are working.

### 2. When the user comes back

They will say something like "改好了", "你看看", "这块还是不对", or paste a lasso note.

Always call **`html_changes` first**, then `html_selection`:

```text
html_changes   {file}                 → what the human changed by hand
html_selection {file}                 → ids + intent + note of the lasso
```

### 3. Review before acting

For every change entry, check it against the current source:

| Journal `type` | What it means | Your job |
|---|---|---|
| `style` | colors, background, gradient, shadow, radius, opacity | keep it; if it contradicts the request, mention it |
| `geometry` | font size, line height, padding, margin, width | keep it; use as the new baseline |
| `text` | old copy → new copy | never overwrite a human's wording unless asked |
| `move` | reorder or dx/dy offset | respect the new position |
| `delete` | element removed by the human | **never add it back** |
| `reset` | element restored to original | treat original as current |
| `layout` | one-click typographic polish | do not re-polish the same page |

Hard rule: if the human deleted something, it was intentional. Do not "helpfully" restore it. If a deletion looks like it broke the page, point it out and ask before changing.

### 4. Apply the lasso intent

Use `intent` from `html_selection`; if it is empty, infer from `note`.

| Intent | Meaning | Tools |
|---|---|---|
| `style` | 改样式 | `html_style` on the returned ids |
| `text` | 改文案 | `html_text` on leaf ids |
| `add` | 加元素 | `html_insert` with `position` = `inside` or `after`; match surrounding classes |
| `all` | 整块交给你 | decide per note: style / text / move / insert |
| empty | no explicit intent | infer from `note`; if still ambiguous, ask one short question |

Rules for ids:

- Only use ids from `html_selection`, `html_outline`, `html_find` or `html_inspect`. Never invent `e12`.
- A container with children cannot take text; the tool will reject it and list children — edit a child instead.
- Reordering works only inside the same parent.
- Style props overwrite only the keys you pass; `""` removes a property.
- There is no browser on the MCP side: solve position issues with spacing, padding, alignment — not pixel coordinates.

### 5. Let the editor sync

After writing, tell the user the editor will sync within ~1 second and their selection/scroll will be kept. Ask them to look and continue. Do not call `html_clean` yet — it removes the ids the editor needs for this session.

### 6. Deliver

Only when the user says they are done:

```text
html_clean  {file}                    → strip data-ct-id and empty style=""
html_editor {action:"stop"}           → close the editor you started
```

If the user is still iterating, leave the editor running.

## Failure handling

| Tool result | What to do |
|---|---|
| `no_changes` | The user only lassoed without hand edits. Skip review, go to `html_selection`. |
| `no_selection` | Nothing was saved. Ask the user to lasso and press "存给 agent", or work from their message plus `html_outline`. |
| `no_such_id` | Re-run `html_outline`; ids shift if the file was changed outside the session. |
| `not_leaf` | The id has children. Use the returned child ids. |
| `cross_container` | Move both elements to the same parent first, or restyle instead. |

## Examples

- "卡片圆角太大了" → user edited radius by hand → `html_changes` shows `style` with `borderRadius` → acknowledge, no change needed.
- "把这张卡删了" → `html_selection` ids `["e26"]`, intent empty → `html_delete` on `e26`.
- "这里再加一个用户评价区" → intent `add` → `html_insert` `position:"after"` (or `inside`) with markup matching existing classes, then invite the user to polish it.
- "按我圈的这块整体收紧一点" → intent `all` → adjust padding/gap/font-size via `html_style` on ids, keep their colors.

Full tool schemas, return shapes and error codes: [references/tools.md](references/tools.md).
