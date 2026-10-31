"""页面精修器 · 本地 MCP 服务（stdio，纯标准库，不需要浏览器）

给 agent 用：只认文件路径。所有改动都是源码级局部替换，没碰到的字节一个字都不动。

工作流（已写进 initialize 的 instructions，模型会先看到）：
  html_outline → html_find → html_style / html_text / html_move → html_clean

工具返回一律是紧凑 JSON：成功带 changed/diff，失败带 error/hint/near，
让模型不用重读整个文件就能判断下一步。
"""

import difflib
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

import htmlops

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PROTOCOL = "2024-11-05"
SERVER = {"name": "page-tuner", "version": "1.6.0"}
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
EDITOR_SCRIPT = os.path.join(PACKAGE_DIR, "server.py")
# 当前由 MCP 拉起来的可视化编辑器（进程 + 端口），供 html_editor 复用 / 停止
EDITOR = {"proc": None, "port": 0, "path": "", "url": ""}

INSTRUCTIONS = (
    "页面精修器：人和 AI 一起改单文件 HTML 的页面。\n"
    "完整流程（按这个走，不要跳步）：\n"
    "1) 你先把页面写出来（自己写 HTML 或改已有文件都行）；\n"
    "2) 调 html_editor（action=start, file=...）起一个本地可视化编辑器，把返回的 url 原样给人，"
    "让他自己点选、改颜色/圆角/悬停、拖顺序、整页一键排版、圈选交给 agent；\n"
    "3) 人改完或圈选后，先调 html_changes 读他亲手改过的每一处"
    "（type = style 改样式 / geometry 改间距尺寸 / text 改文案 / move 挪位置或换顺序 / "
    "delete 删元素 / reset 重置 / layout 一键排版），对照当前源码审一遍：和已有改动冲突的、"
    "重复的、误删的要指出并修正；然后调 html_selection 拿到他框住的 id、意图和原话，"
    "再用 html_style/html_text/html_insert/html_delete/html_move 按 id 改同一个文件；\n"
    "4) 你改完，编辑器会自动同步，人继续微调；他再次存给 agent 时重复第 3 步（这是「审核」环节，不能跳）。"
    "交付前调 html_clean，最后可 html_editor(action=stop)。\n"
    "什么时候用哪些工具：改外观→html_style；改字→html_text；加块→html_insert；删块→html_delete；"
    "挪位置→html_move；想知道人改了什么→html_changes；找不到元素→html_outline / html_find；"
    "拿不准→html_inspect。\n"
    "如果 html_changes 显示人删了什么、加在哪、挪到哪，先确认这些改动合不合理再往下做："
    "人有意删掉的重复功能不要自作主张加回来。\n"
    "规则：id 在会话里稳定，改完不用重新 outline；样式只覆盖传入的属性，其余不动；"
    "有子元素的容器不能改文字（会被拒绝并列出子元素 id）；只能在同一父容器内调顺序；"
    "MCP 这边没有浏览器，拿不到像素坐标，位置问题用间距/内边距/对齐解决；"
    "「整页一键排版」需要浏览器里的计算样式，只有人在编辑器里点才准，MCP 不模拟。\n"
    "返回是紧凑 JSON：成功有 changed/diff，失败有 error/hint/near，照着 hint 走。"
)

TOOLS = [
    {
        "name": "html_outline",
        "description": "看页面结构：列出可编辑元素及其 id、标签、类名、直接文字。所有后续操作用这里的 id。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "HTML 文件路径（绝对路径最稳）"},
                "max_depth": {"type": "integer", "description": "列到第几层，默认 6"},
                "max_text": {"type": "integer", "description": "每个元素文字截断长度，默认 36"},
                "limit": {"type": "integer", "description": "最多列多少行，默认 300，防止大页面刷屏"},
            },
            "required": ["file"],
        },
    },
    {
        "name": "html_find",
        "description": "按标签 / 类名 / 文字片段找元素，返回 id 列表。适合「所有卡片」「所有按钮」这类批量定位。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string"},
                "tag": {"type": "string", "description": "标签名，如 div、article、h2"},
                "cls": {"type": "string", "description": "类名片段，如 card"},
                "text": {"type": "string", "description": "直接文字里包含的片段"},
                "limit": {"type": "integer", "description": "默认 50"},
            },
            "required": ["file"],
        },
    },
    {
        "name": "html_inspect",
        "description": "看一个元素的详情：开标签原文、直接文字、子元素 id、父元素，用来确认到底在改什么。",
        "inputSchema": {
            "type": "object",
            "properties": {"file": {"type": "string"}, "id": {"type": "string"}},
            "required": ["file", "id"],
        },
    },
    {
        "name": "html_style",
        "description": "改 inline 样式，可一次改多个元素（ids 数组，同一组 props）。只覆盖传入的属性；值传空字符串表示删掉该属性。键可用 fontSize 或 font-size。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string"},
                "ids": {"type": "array", "items": {"type": "string"}, "description": "元素 id 列表，如 [\"e20\",\"e23\"]"},
                "props": {"type": "object", "additionalProperties": True,
                          "description": "如 {\"paddingTop\":\"20px\",\"borderRadius\":\"12px\"}"},
            },
            "required": ["file", "ids", "props"],
        },
    },
    {
        "name": "html_text",
        "description": "改一个元素的文字。只对叶子元素有效；容器会被拒绝并返回它的子元素 id，照着改子元素即可。",
        "inputSchema": {
            "type": "object",
            "properties": {"file": {"type": "string"}, "id": {"type": "string"}, "text": {"type": "string"}},
            "required": ["file", "id", "text"],
        },
    },
    {
        "name": "html_move",
        "description": "同一父容器内调顺序：up/down 前后挪一位；before/after 需要 target_id。跨容器移动会破坏样式继承，工具会拒绝。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string"},
                "id": {"type": "string"},
                "direction": {"type": "string", "enum": ["up", "down", "before", "after"]},
                "target_id": {"type": "string"},
            },
            "required": ["file", "id", "direction"],
        },
    },
    {
        "name": "html_insert",
        "description": "在某个元素的前/后/内部插入一段 HTML（新增卡片、按钮、整行内容都靠它）。插入后会返回新元素的 id，可直接接着改。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string"},
                "id": {"type": "string", "description": "锚点元素 id（新内容放在它旁边/里面）"},
                "position": {"type": "string", "enum": ["before", "after", "inside"],
                             "description": "after=同一层放在它后面（默认），before=同一层放在它前面，inside=放进它内部当最后一个子元素"},
                "html": {"type": "string", "description": "要插入的 HTML 片段，如 \"<div class=\\\"card\\\"><h3>新卡片</h3><p>说明</p></div>\""},
            },
            "required": ["file", "id", "html"],
        },
    },
    {
        "name": "html_delete",
        "description": "删掉一个元素（连同它整行的缩进）。删除前先 html_inspect 确认 id 对，删错了没有撤销。",
        "inputSchema": {
            "type": "object",
            "properties": {"file": {"type": "string"}, "id": {"type": "string"}},
            "required": ["file", "id"],
        },
        "annotations": {"title": "删除元素", "destructiveHint": True, "idempotentHint": False},
    },
    {
        "name": "html_clean",
        "description": "交付前清理：删掉工具写入的 data-ct-id 和空 style=\"\"，其余不动。改完后调用一次即可。",
        "inputSchema": {"type": "object", "properties": {"file": {"type": "string"}}, "required": ["file"]},
    },
    {
        "name": "html_changes",
        "description": "读人在编辑器里亲手做过的改动（改样式 / 改间距尺寸 / 改文案 / 挪位置换顺序 / 删元素 / 重置 / 整页一键排版），"
                       "按时间正序返回 type、元素 id、属性、前后文字、位移等结构化记录。人存给 agent 后先调它审一遍，再动手改。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "HTML 文件路径（和编辑器打开的是同一个）"},
                "clear": {"type": "boolean", "description": "读完就删掉这份改动日志，默认 false"},
                "limit": {"type": "integer", "description": "只返回最近多少条，默认 100"},
            },
            "required": ["file"],
        },
    },
    {
        "name": "html_editor",
        "description": "起/停本地可视化编辑器，把人和 AI 接成一个闭环。start 返回 url（原样交给用户打开）；"
                       "用户在网页里点选微调、圈选后，用 html_selection 继续；stop 关掉。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["start", "status", "stop"],
                           "description": "start=启动并返回地址，status=查是否还活着，stop=关掉"},
                "file": {"type": "string", "description": "要编辑的 HTML 文件（start 必填）"},
                "port": {"type": "integer", "description": "可选，默认从 8766 起找空端口"},
            },
            "required": ["action"],
        },
        "annotations": {"title": "打开可视化编辑器", "destructiveHint": False, "idempotentHint": True},
    },
    {
        "name": "html_selection",
        "description": "读用户在编辑器里刚圈出的区域：框住了哪些元素（id / 标签 / 类名 / 文字 / 关键样式）、共同父级、以及他写的原话。用户说「这块 / 这里 / 我圈了」时先调它，直接按 id 改，不要猜。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file": {"type": "string", "description": "HTML 文件路径（和编辑器打开的是同一个）"},
                "clear": {"type": "boolean", "description": "读完就删掉这份选区，默认 false"},
            },
            "required": ["file"],
        },
    },
]


# 编辑器改动日志里的 type → 给人看的中文（编辑器侧 record() 写的就是这几个）
CHANGE_TYPES = {
    "style": "改样式",
    "geometry": "改尺寸间距",
    "text": "改文案",
    "move": "挪位置/换顺序",
    "delete": "删元素",
    "reset": "重置元素",
    "layout": "整页一键排版",
}


class ToolError(Exception):
    def __init__(self, code, message, hint="", near=None):
        self.code = code
        self.message = message
        self.hint = hint
        self.near = near or []
        super().__init__(message)


def dump(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def reply(payload, is_error=False):
    out = {"content": [{"type": "text", "text": dump(payload)}]}
    if is_error:
        out["isError"] = True
    return out


def _check_file(path):
    if not isinstance(path, str) or not path:
        raise ToolError("bad_file", "缺少 file 参数", "传页面 HTML 的路径，绝对路径最稳")
    if not os.path.isfile(path):
        raise ToolError("bad_file", "文件不存在：%s" % path, "确认路径；只处理单文件 HTML")
    return os.path.abspath(path)


def _load(path):
    """读文件并把缺的 id 补进源码，后续节点位置都以写回后的文本为准。"""
    text = htmlops.read(path)
    root = htmlops.parse(text)
    nodes, added = htmlops.index_ids(text, root)
    if added:
        text = htmlops.apply_ids(text, root, nodes)
        htmlops.write(path, text)
        root = htmlops.parse(text)
        nodes, _ = htmlops.index_ids(text, root)
    return text, root, nodes


def _node(nodes, eid):
    node = htmlops.find(nodes, eid)
    if node is not None:
        return node
    near = [n.eid for n in nodes if n.eid and eid and n.eid.lstrip("e").isdigit()
            and eid.lstrip("e").isdigit()
            and abs(int(n.eid[1:]) - int(eid[1:])) <= 2][:5]
    raise ToolError("no_such_id", "没有 id=%s 的元素" % eid,
                    "id 来自 html_outline / html_find；若文件被外部改过，重新 outline 一次",
                    near or [n.eid for n in nodes][:5])


def _eid_num(eid):
    if isinstance(eid, str) and re.match(r"^e\d+$", eid):
        return int(eid[1:])
    return -1


def _diff(before, after, limit=16):
    lines = [l.rstrip("\n") for l in difflib.unified_diff(before.splitlines(), after.splitlines(), n=0)
             if l[:1] in "+-" and not l.startswith(("+++", "---"))]
    return "\n".join(lines[:limit])


def _save(path, before, after):
    if after == before:
        return False
    htmlops.write(path, after)
    return True


def _label(text, node, width=28):
    cls = htmlops.get_attr(text, node, "class")
    inner = text[node.inner_start:node.inner_end]
    plain = "" if "<" in inner else " ".join(inner.split())[:width]
    return {"id": node.eid, "tag": node.tag,
            "cls": cls, "text": plain}


def tool_outline(args):
    path = _check_file(args["file"])
    depth_max = int(args.get("max_depth", 6))
    text_max = int(args.get("max_text", 36))
    limit = int(args.get("limit", 300))
    text, root, nodes = _load(path)
    lines = []
    hidden = 0
    for node, depth in htmlops.editable_nodes(root):
        if depth > depth_max:
            continue
        if len(lines) >= limit:
            hidden += 1
            continue
        cls = htmlops.get_attr(text, node, "class")
        label = ("." + cls.replace(" ", "."))[:24] if cls else ""
        inner = text[node.inner_start:node.inner_end]
        plain = "" if "<" in inner else " ".join(inner.split())[:text_max]
        lines.append("%s%s %s%s%s" % ("  " * (depth - 1), node.eid, node.tag, label,
                                      ("  「%s」" % plain) if plain else ""))
    return reply({
        "ok": True,
        "file": os.path.basename(path),
        "elements": len(nodes),
        "truncated": hidden,
        "tree": "\n".join(lines),
        "next": "用这些 id 调 html_style / html_text / html_move；交付前 html_clean",
    })


def tool_find(args):
    path = _check_file(args["file"])
    limit = int(args.get("limit", 50))
    want_tag = (args.get("tag") or "").lower()
    want_cls = (args.get("cls") or "").strip()
    want_text = (args.get("text") or "").strip()
    if not (want_tag or want_cls or want_text):
        raise ToolError("bad_query", "tag / cls / text 至少给一个",
                        "例如 {\"cls\":\"card\"} 或 {\"tag\":\"h2\"}")
    text, root, nodes = _load(path)
    hits = []
    for node, _depth in htmlops.editable_nodes(root):
        if want_tag and node.tag != want_tag:
            continue
        if want_cls:
            cls = htmlops.get_attr(text, node, "class")
            if want_cls not in cls.split():
                continue
        if want_text:
            inner = text[node.inner_start:node.inner_end]
            if "<" in inner or want_text not in inner:
                continue
        hits.append(_label(text, node))
        if len(hits) >= limit:
            break
    return reply({
        "ok": True,
        "matches": hits,
        "truncated": len(hits) >= limit,
        "hint": "" if hits else "没命中：检查类名是否带前缀，或先用 html_outline 看真实类名",
    })


def tool_inspect(args):
    path = _check_file(args["file"])
    text, root, nodes = _load(path)
    node = _node(nodes, args.get("id"))
    inner = text[node.inner_start:node.inner_end]
    plain = "" if "<" in inner else " ".join(inner.split())[:300]
    return reply({
        "ok": True,
        "element": {
            "id": node.eid,
            "tag": node.tag,
            "opening": htmlops.opening(text, node).strip(),
            "direct_text": plain,
            "has_children": bool(node.children),
            "children": [c.eid or c.tag for c in node.children],
            "parent": (node.parent.eid if node.parent and node.parent.eid else node.parent.tag),
        },
    })


def tool_style(args):
    path = _check_file(args["file"])
    ids = args.get("ids")
    if isinstance(ids, str):
        ids = [ids]
    if not isinstance(ids, list) or not ids:
        raise ToolError("bad_ids", "ids 必须是非空数组", "例如 ids=[\"e20\",\"e23\"]")
    props = args.get("props") or {}
    if not isinstance(props, dict) or not props:
        raise ToolError("bad_props", "props 不能为空", "例如 {\"fontSize\":\"28px\"}")
    text, root, nodes = _load(path)
    targets = [_node(nodes, eid) for eid in ids]        # 先全部校验，再统一改，避免半截写入
    before = text
    for node in sorted(targets, key=lambda n: n.start, reverse=True):
        text = htmlops.set_style(text, node, props)
    changed = _save(path, before, text)
    return reply({
        "ok": True,
        "changed": [n.eid for n in targets],
        "noop": not changed,
        "props": {htmlops.to_kebab(k): v for k, v in props.items()},
        "diff": _diff(before, text),
        "hint": "" if changed else "属性值和现值相同，文件没变",
    })


def tool_text(args):
    path = _check_file(args["file"])
    text, root, nodes = _load(path)
    node = _node(nodes, args.get("id"))
    if node.children:
        kids = [c.eid or c.tag for c in node.children]
        raise ToolError("not_leaf", "%s 是容器，直接改文字会把它整段子结构替换掉" % node.eid,
                        "改到子元素上：%s" % ", ".join(kids), kids)
    value = args.get("text", "")
    before = text
    after = htmlops.set_text(text, node, value)
    _save(path, before, after)
    return reply({"ok": True, "changed": [node.eid], "text": value,
                  "diff": _diff(before, after)})


def tool_move(args):
    path = _check_file(args["file"])
    direction = args.get("direction")
    if direction not in ("up", "down", "before", "after"):
        raise ToolError("bad_direction", "direction 只能是 up/down/before/after", "")
    text, root, nodes = _load(path)
    node = _node(nodes, args.get("id"))
    parent = node.parent
    siblings = [c for c in parent.children if c.editable]
    if node not in siblings:
        raise ToolError("not_movable", "%s 的父容器不可编辑" % node.eid, "")
    idx = siblings.index(node)
    if direction == "up":
        if idx == 0:
            raise ToolError("already_first", "%s 已经是同级第一个" % node.eid,
                            "要跨区块调整，改父级区块的顺序")
        target, before = siblings[idx - 1], True
    elif direction == "down":
        if idx + 1 >= len(siblings):
            raise ToolError("already_last", "%s 已经是同级最后一个" % node.eid,
                            "要跨区块调整，改父级区块的顺序")
        target, before = siblings[idx + 1], False
    else:
        tid = args.get("target_id")
        if not tid:
            raise ToolError("bad_target", "direction=%s 需要 target_id" % direction,
                            "例如 target_id=\"e23\"")
        target = _node(nodes, tid)
        if target.parent is not node.parent:
            raise ToolError("cross_container", "%s 和 %s 不在同一个父容器" % (node.eid, tid),
                            "跨容器移动会破坏样式继承；改成调整样式，或先移动整个区块")
        before = direction == "before"
    after = htmlops.move(text, node, target, before)
    _save(path, text, after)
    _, root2, nodes2 = _load(path)
    parent_now = _node(nodes2, node.eid).parent
    order = [c.eid for c in parent_now.children if c.editable]
    return reply({"ok": True, "changed": [node.eid], "order": order,
                  "diff": _diff(text, after)})


def tool_insert(args):
    path = _check_file(args["file"])
    anchor_id = args.get("id")
    position = args.get("position") or "after"
    if position not in ("before", "after", "inside"):
        raise ToolError("bad_position", "position 只能是 before/after/inside",
                        "after=同一层放在它后面，inside=放进它内部当最后一个子元素")
    snippet = args.get("html")
    if not isinstance(snippet, str) or "<" not in snippet:
        raise ToolError("bad_html", "html 必须是一段标签",
                        "例如 \"<div class=\\\"card\\\"><h3>新卡片</h3></div>\"")
    text, root, nodes = _load(path)
    anchor = _node(nodes, anchor_id)
    max_before = max([_eid_num(n.eid) for n in nodes], default=-1)
    after = htmlops.insert(text, anchor, snippet, position)
    if not after or after == text:
        raise ToolError("no_change", "没插进去：html 是空的", "")
    htmlops.write(path, after)
    # 重新编号并把新元素的 id 写进源码，agent 下一步可以直接拿这些 id 改
    text2, _root2, nodes2 = _load(path)
    new_nodes = [n for n in nodes2 if _eid_num(n.eid) > max_before]
    return reply({
        "ok": True,
        "anchor": anchor_id,
        "position": position,
        "inserted": [{"id": n.eid, "tag": n.tag,
                      "cls": htmlops.get_attr(text2, n, "class")} for n in new_nodes],
        "diff": _diff(text, text2),
        "hint": "新元素已经带 id，可直接 html_style / html_text；交付前 html_clean",
    })


def tool_delete(args):
    path = _check_file(args["file"])
    text, root, nodes = _load(path)
    node = _node(nodes, args.get("id"))
    if node.tag in ("html", "body"):
        raise ToolError("bad_target", "html / body 不能删",
                        "要清空整段就删里面的 section / div")
    cls = htmlops.get_attr(text, node, "class")
    after = htmlops.delete_node(text, node)
    if after == text:
        raise ToolError("no_change", "没删掉，确认这个 id 还在页面上", "")
    _save(path, text, after)
    text2, _root2, _nodes2 = _load(path)
    return reply({
        "ok": True,
        "removed": {"id": node.eid, "tag": node.tag, "cls": cls},
        "diff": _diff(text, text2),
        "hint": "删完如果还有别的地方引用这个元素（比如锚点、aria），记得一起清；交付前 html_clean",
    })


def tool_clean(args):
    path = _check_file(args["file"])
    text = htmlops.read(path)
    cleaned = htmlops.clean_ids(text)
    removed = len(re.findall(r"\sdata-ct-id\s*=", text, re.I))
    htmlops.write(path, cleaned)
    return reply({"ok": True, "removed_ids": removed,
                  "bytes": len(cleaned.encode("utf-8")),
                  "unchanged": cleaned == text})


def tool_selection(args):
    path = _check_file(args["file"])
    side = path + ".selection.json"
    if not os.path.isfile(side):
        return reply({"ok": False, "error": "no_selection",
                      "message": "还没人圈选：找不到 %s" % os.path.basename(side),
                      "hint": "让用户在页面精修器里点「圈选区域」拖框、写一句需求、点「存给 agent」，再调本工具"}, True)
    try:
        with open(side, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        return reply({"ok": False, "error": "bad_selection", "message": str(exc),
                      "hint": "让用户重新圈选一次并「存给 agent」"}, True)
    items = (data.get("data") or {}).get("items") or []
    ids = [item.get("id") for item in items if item.get("id")]
    cleared = bool(args.get("clear"))
    if cleared:
        try:
            os.remove(side)
        except OSError:
            cleared = False
    return reply({"ok": True,
                  "page": data.get("page"),
                  "saved_at": data.get("saved_at"),
                  "note": data.get("note") or "",
                  "intent": data.get("intent") or "",
                  "state": data.get("state") or None,
                  "count": len(items),
                  "ids": ids,
                  "text": data.get("text", ""),
                  "cleared": cleared})


def tool_changes(args):
    path = _check_file(args["file"])
    side = path + ".changes.json"
    if not os.path.isfile(side):
        return reply({"ok": False, "error": "no_changes",
                      "message": "人还没在编辑器里改动过：找不到 %s" % os.path.basename(side),
                      "hint": "没人改过就跳过这一步，直接用 html_outline / html_selection"}, True)
    try:
        with open(side, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        return reply({"ok": False, "error": "bad_changes", "message": str(exc),
                      "hint": "让人在编辑器里再动一下，日志会重新写"}, True)
    entries = data.get("entries")
    if not isinstance(entries, list):
        entries = []
    limit = int(args.get("limit") or 100)
    kinds = {}
    for item in entries:
        key = item.get("type") if isinstance(item, dict) else None
        key = key or "?"
        kinds[key] = kinds.get(key, 0) + 1
    cleared = bool(args.get("clear"))
    if cleared:
        try:
            os.remove(side)
        except OSError:
            cleared = False
    return reply({"ok": True,
                  "page": data.get("page"),
                  "saved_at": data.get("saved_at"),
                  "count": len(entries),
                  "shown": min(len(entries), limit),
                  "summary": {CHANGE_TYPES.get(k, k): v for k, v in kinds.items()},
                  "entries": entries[-limit:],
                  "cleared": cleared,
                  "hint": "先审这些改动：和源码冲突、重复、误删的要指出并修正；"
                          "人有意的删除不要加回来；再按 html_selection 的意图继续改，改完交回人看"})


def tool_editor(args):
    action = (args.get("action") or "start").lower()
    if action == "status":
        port = EDITOR["port"]
        meta = _editor_meta(port) if port else None
        alive = bool(EDITOR["proc"] and EDITOR["proc"].poll() is None and meta)
        return reply({"ok": True, "running": alive,
                      "url": EDITOR["url"] if alive else "",
                      "file": (meta or {}).get("file", ""),
                      "port": port if alive else 0})
    if action == "stop":
        was = EDITOR["url"]
        _stop_editor()
        return reply({"ok": True, "stopped": bool(was), "url": was})
    if action != "start":
        raise ToolError("bad_action", "action 只能是 start / status / stop",
                        "start 起编辑器并返回 url，stop 关掉")

    path = _check_file(args.get("file"))
    if EDITOR["proc"] and EDITOR["proc"].poll() is None and EDITOR["path"] == path:
        meta = _editor_meta(EDITOR["port"])
        if meta:
            return reply({"ok": True, "reused": True, "url": EDITOR["url"],
                          "port": EDITOR["port"], "file": meta.get("file"),
                          "hint": "把这个 url 原样交给用户；他圈选后调 html_selection"})

    _stop_editor()
    port = int(args.get("port") or 0) or 8766
    while not _port_free(port):
        port += 1
        if port > 8799:
            raise ToolError("no_port", "8766-8799 都被占了",
                            "关掉不用的编辑器，或者手动指定 port")
    try:
        proc = subprocess.Popen([sys.executable, EDITOR_SCRIPT, path, "--port", str(port)],
                                cwd=PACKAGE_DIR, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        raise ToolError("spawn_failed", "起不来编辑器：%s" % exc,
                        "确认 server.py 和 static/ 都在包目录里")
    deadline = time.time() + 6
    meta = None
    while time.time() < deadline:
        meta = _editor_meta(port, timeout=0.4)
        if meta:
            break
        if proc.poll() is not None:
            break
        time.sleep(0.15)
    if not meta:
        try:
            proc.kill()
        except Exception:
            pass
        raise ToolError("start_failed", "编辑器进程没起来（端口 %d）" % port,
                        "换个 port 再试；或直接在终端 python server.py <file>")
    EDITOR.update({"proc": proc, "port": port, "path": path,
                   "url": "http://127.0.0.1:%d/" % port})
    return reply({"ok": True, "url": EDITOR["url"], "port": port,
                  "pages": meta.get("pages", []),
                  "hint": "把这个 url 原样交给用户；他点选/圈选后调 html_selection；交付前 html_clean"})


def _port_free(port):
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _editor_meta(port, timeout=1.0):
    if not port:
        return None
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/meta" % port, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except Exception:
        return None


def _stop_editor():
    proc = EDITOR.get("proc")
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except Exception:
            proc.kill()
    EDITOR.update({"proc": None, "port": 0, "path": "", "url": ""})


HANDLERS = {
    "html_outline": tool_outline,
    "html_find": tool_find,
    "html_inspect": tool_inspect,
    "html_style": tool_style,
    "html_text": tool_text,
    "html_move": tool_move,
    "html_insert": tool_insert,
    "html_delete": tool_delete,
    "html_clean": tool_clean,
    "html_selection": tool_selection,
    "html_changes": tool_changes,
    "html_editor": tool_editor,
}


def respond(mid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": mid}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(msg):
    method = msg.get("method")
    mid = msg.get("id")
    if mid is None:
        return  # 通知不回
    if method == "initialize":
        params = msg.get("params") or {}
        respond(mid, {"protocolVersion": params.get("protocolVersion") or PROTOCOL,
                      "capabilities": {"tools": {}},
                      "serverInfo": SERVER,
                      "instructions": INSTRUCTIONS})
    elif method == "tools/list":
        respond(mid, {"tools": TOOLS})
    elif method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        handler = HANDLERS.get(name)
        if handler is None:
            respond(mid, reply({"ok": False, "error": "unknown_tool",
                                "message": "没有这个工具：%s" % name,
                                "hint": "可用：" + ", ".join(HANDLERS)}, True))
        else:
            try:
                respond(mid, handler(params.get("arguments") or {}))
            except ToolError as exc:
                payload = {"ok": False, "error": exc.code, "message": exc.message}
                if exc.hint:
                    payload["hint"] = exc.hint
                if exc.near:
                    payload["near"] = exc.near
                respond(mid, reply(payload, True))
            except Exception as exc:  # 单个坏调用不能把服务打死
                respond(mid, reply({"ok": False, "error": "internal",
                                    "message": "%s: %s" % (type(exc).__name__, exc),
                                    "hint": "确认 file 是单文件 HTML；必要时重新 html_outline"}, True))
    elif method == "ping":
        respond(mid, {})
    else:
        respond(mid, error={"code": -32601, "message": "不支持的方法：%s" % method})


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            sys.stderr.write("坏消息：%s\n" % raw[:200])
            continue
        handle(msg)


if __name__ == "__main__":
    main()
