# page-tuner MCP · tool reference

Twelve stdio tools. All paths are absolute; all results are compact JSON (`ok`, plus either `changed`/`diff` or `error`/`hint`/`near`).

## Session tools

### `html_editor`
Start, inspect or stop the local visual editor.

```json
{"action": "start|status|stop", "file": "/abs/page.html", "port": 8766}
```

- `start` → `{ok, url, port, pages, hint}`. Hand `url` to the user verbatim.
- Same file + live process → returns `{reused: true}`.
- `stop` only stops the editor this MCP session started.
- Editor binds `127.0.0.1`; it is not a remote service.

## Read tools

### `html_outline`
```json
{"file": "/abs/page.html", "max_depth": 6, "max_text": 36, "limit": 300}
```
Returns `{elements, tree, truncated}`. `tree` lines look like `e12 div.card 「标题…」`. Use these ids everywhere else.

### `html_find`
```json
{"file": "...", "tag": "div", "cls": "card", "text": "价格", "limit": 50}
```
Returns `{matches: [{id, tag, cls, text}], truncated, hint}`. All filters are AND-ed.

### `html_inspect`
```json
{"file": "...", "id": "e20"}
```
Returns `{element: {id, tag, opening, direct_text, has_children, children, parent}}`. Use before destructive edits.

### `html_changes`
```json
{"file": "...", "clear": false, "limit": 100}
```
Reads `<page>.changes.json` written by the editor.

Returns:

```json
{"ok": true, "page": "index.html", "saved_at": "...", "count": 7, "shown": 7,
 "summary": {"改样式": 2, "改文案": 1, "挪位置/换顺序": 1, "删元素": 1},
 "entries": [{"type": "style", "id": "e20", "tag": "div", "cls": "card",
              "props": {"borderRadius": "22px"}, "state": "base", "at": "10:32:01"}],
 "cleared": false}
```

Entry types: `style`, `geometry`, `text`, `move`, `delete`, `reset`, `layout`.
Missing file → `{ok:false, error:"no_changes"}` (not a failure; just skip review).

### `html_selection`
```json
{"file": "...", "clear": false}
```
Reads `<page>.selection.json`.

```json
{"ok": true, "page": "index.html", "saved_at": "...",
 "note": "在这排最后加一张卡", "intent": "add", "count": 5,
 "ids": ["e20","e23","e26","e29","e32"], "text": "...", "cleared": false}
```

`intent` values: `style` / `text` / `add` / `all` / `""`. `clear: true` deletes the file after reading.
Missing file → `{ok:false, error:"no_selection"}`.

## Write tools

### `html_style`
```json
{"file": "...", "ids": ["e20","e23"], "props": {"borderRadius": "16px", "paddingTop": "20px"}}
```
- Sets inline CSS on every id; only the passed keys are touched.
- `""` removes a property.
- Keys may be camelCase or kebab-case.
- Returns `{changed, noop, props, diff}`.

Note: visual properties (color, background, gradient, opacity, shadow, radius, transform) may already live in a generated `.pt-N` class. Writing inline still wins visually, but prefer editing the class through the editor when the human is working there.

### `html_text`
```json
{"file": "...", "id": "e31", "text": "立即下单"}
```
Leaf elements only. Containers return `not_leaf` plus their child ids. Returns `{changed, text, diff}`.

### `html_move`
```json
{"file": "...", "id": "e26", "direction": "up|down|before|after", "target_id": "e23"}
```
Same parent only. Returns `{changed, order, diff}`.

### `html_insert`
```json
{"file": "...", "id": "e26", "position": "before|after|inside",
 "html": "<div class=\"card\"><h3>团队协作</h3><p>共享空间与版本记录</p></div>"}
```
- `after` (default) and `before` insert as siblings; `inside` appends as the last child.
- Indentation is matched to the anchor's children.
- Returns `{anchor, position, inserted:[{id, tag, cls}], diff}` — the new ids are immediately usable.

### `html_delete`
```json
{"file": "...", "id": "e26"}
```
Deletes the element including its indentation. Destructive and not undoable (the human can undo in the editor only before saving). Inspect first. Returns `{removed:{id, tag, cls}, diff}`.

### `html_clean`
```json
{"file": "..."}
```
Strips `data-ct-id` and empty `style=""` before delivery. Do this **only** when the user is done; afterwards the open editor can no longer map ids.

## Sidecar files

The editor writes them next to the page; ignore them in version control:

- `<page>.changes.json` — journal of hand edits, last 300 entries, rewritten atomically every ~400ms.
- `<page>.selection.json` — lasso snapshot + `note` + `intent`.

`html_changes` / `html_selection` with `clear: true` remove the file after reading. Leave `clear` false until the iteration is fully handled, otherwise the human's next turn has no context.

## Error codes

| code | meaning | fix |
|---|---|---|
| `bad_file` | missing / not a file | pass an absolute path to a single-file HTML |
| `no_such_id` | id not in the current source | `html_outline` again |
| `not_leaf` | text edit on a container | use the returned child ids |
| `cross_container` | move across parents | move within one parent, or restyle |
| `already_first` / `already_last` | reorder at the edge | move the parent block instead |
| `not_movable` | parent not editable | adjust the parent |
| `no_change` | insert/delete produced no diff | re-inspect the anchor |
| `no_changes` / `no_selection` | sidecar absent | skip review / ask the user to save the lasso |
| `no_port` | 8766–8799 all taken | pass `port` or stop an old editor |
