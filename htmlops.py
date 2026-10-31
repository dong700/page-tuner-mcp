"""源码级 HTML 编辑：只在原文上做局部替换，没被点到的字节一律不动。

为什么不重新序列化整棵树：HTMLParser/dom 反序列化会改写引号、布尔属性、空白和注释，
对「AI 生成的单文件页面」这种一改就 difff 全红的产物是灾难。这里只记录每个标签的
起止位置，改动时按位置拼接。
"""

import html as _html
import os
import re

SKIP_TAGS = {"script", "style", "link", "meta", "head", "title", "noscript", "br", "template"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
             "meta", "param", "source", "track", "wbr"}
RAW_TAGS = {"script", "style", "textarea", "title"}

_OPEN_RE = re.compile(r"[A-Za-z][^\s/>]*")
_CLOSE_RE = {t: re.compile(r"</\s*" + t + r"\s*>", re.I) for t in RAW_TAGS}
_STYLE_RE = re.compile(r"\sstyle\s*=\s*(\"([^\"]*)\"|'([^']*)')", re.I)
_ID_RE = re.compile(r"\sdata-ct-id\s*=\s*(\"[^\"]*\"|'[^']*')", re.I)
_TAG_ID_RE = re.compile(r"^e\d+$")


class Node:
    __slots__ = ("tag", "start", "open_end", "inner_start", "inner_end", "end",
                 "children", "parent", "eid")

    def __init__(self, tag, start, open_end, inner_start, inner_end, end=None):
        self.tag = tag
        self.start = start
        self.open_end = open_end
        self.inner_start = inner_start
        self.inner_end = inner_end
        self.end = inner_end if end is None else end
        self.children = []
        self.parent = None
        self.eid = None

    @property
    def editable(self):
        return self.tag not in SKIP_TAGS and self.tag not in ("#root", "html", "body")


def parse(text):
    root = Node("#root", 0, 0, 0, len(text))
    stack = [root]
    i = 0
    n = len(text)
    while i < n:
        lt = text.find("<", i)
        if lt < 0:
            break
        if text.startswith("<!--", lt):
            j = text.find("-->", lt + 4)
            i = n if j < 0 else j + 3
            continue
        if text.startswith("<!", lt) or text.startswith("<?", lt) or text.startswith("</>", lt):
            j = text.find(">", lt)
            i = n if j < 0 else j + 1
            continue
        if text.startswith("</", lt):
            j = text.find(">", lt)
            if j < 0:
                break
            name = text[lt + 2:j].strip().split(" ")[0].lower()
            for k in range(len(stack) - 1, 0, -1):
                if stack[k].tag == name:
                    node = stack[k]
                    node.inner_end = lt
                    node.end = j + 1
                    del stack[k:]
                    break
            i = j + 1
            continue

        m = _OPEN_RE.match(text, lt + 1)
        if not m:
            i = lt + 1
            continue
        tag = m.group(0).lower()
        k = m.end()
        quote = None
        while k < n:
            ch = text[k]
            if quote:
                if ch == quote:
                    quote = None
            elif ch in "\"'":
                quote = ch
            elif ch == ">":
                break
            k += 1
        if k >= n:
            break
        open_end = k + 1
        node = Node(tag, lt, open_end, open_end, open_end, open_end)
        node.parent = stack[-1]
        stack[-1].children.append(node)

        if tag in VOID_TAGS or text[k - 1] == "/":
            pass
        elif tag in RAW_TAGS:
            mm = _CLOSE_RE[tag].search(text, open_end)
            if mm:
                node.inner_end = mm.start()
                node.end = mm.end()
                i = mm.end()
                continue
            node.inner_end = node.end = n
            continue
        else:
            stack.append(node)
        i = open_end

    for node in stack[1:]:
        node.end = n
        if node.inner_end == node.open_end:
            node.inner_end = n
    return root


def walk(root, depth=1):
    for child in root.children:
        yield child, depth
        yield from walk(child, depth + 1)


def editable_nodes(root):
    """深度按「可编辑元素」嵌套算，html/body 这类不计层，避免 max_depth=2 反而什么都看不到。"""
    out = []

    def rec(node, depth):
        for child in node.children:
            if child.editable:
                out.append((child, depth))
                rec(child, depth + 1)
            else:
                rec(child, depth)

    rec(root, 1)
    return out


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    os.replace(tmp, path)


def opening(text, node):
    return text[node.start:node.open_end]


def current_id(text, node):
    m = _ID_RE.search(opening(text, node))
    if not m:
        return None
    return m.group(1)[1:-1]


def get_attr(text, node, name):
    m = re.search(r"\s" + name + r"\s*=\s*(\"([^\"]*)\"|'([^']*)')",
                  opening(text, node), re.I)
    if not m:
        return ""
    return m.group(2) if m.group(2) is not None else m.group(3)


def index_ids(text, root):
    """给所有可编辑元素分配 id。已有 id 保留，缺的补 max+1（两趟，先扫最大值）。"""
    nodes = [node for node, _ in editable_nodes(root)]
    max_n = -1
    for node in nodes:
        eid = current_id(text, node)
        if eid and _TAG_ID_RE.match(eid):
            node.eid = eid
            max_n = max(max_n, int(eid[1:]))
    added = 0
    for node in nodes:
        if node.eid:
            continue
        max_n += 1
        node.eid = "e%d" % max_n
        added += 1
    return nodes, added


def insert_in_tag(raw, piece):
    """把一段属性插到开标签的 '>' 前（自闭合则插到 '/>' 前），不制造多余空格。"""
    cut = len(raw) - 1
    if raw.endswith("/>"):
        cut -= 1
    gap = "" if not raw[:cut] or raw[cut - 1] in " \t\r\n/" else " "
    return raw[:cut] + gap + piece.lstrip() + raw[cut:]


def apply_ids(text, root, nodes):
    """把缺的 id 写进开标签，从后往前插，前面的位置不受影响。"""
    work = [(node, 'data-ct-id="%s"' % node.eid) for node in nodes
            if current_id(text, node) != node.eid]
    for node, piece in sorted(work, key=lambda item: item[0].start, reverse=True):
        raw = opening(text, node)
        text = text[:node.start] + insert_in_tag(raw, piece) + text[node.open_end:]
    return text


def find(node_list, eid):
    for node in node_list:
        if node.eid == eid:
            return node
    return None


def to_kebab(key):
    return re.sub(r"([A-Z])", lambda m: "-" + m.group(1).lower(), key).lstrip("-")


def css_pairs(value):
    pairs = []
    for part in value.split(";"):
        if ":" not in part:
            continue
        name, val = part.split(":", 1)
        name = name.strip()
        if name:
            pairs.append((name, val.strip()))
    return pairs


def set_style(text, node, props):
    css = [(to_kebab(k), str(v).replace('"', "&quot;")) for k, v in props.items()]
    raw = opening(text, node)
    m = _STYLE_RE.search(raw)
    if m:
        old = m.group(2) if m.group(2) is not None else m.group(3)
        pairs = css_pairs(old)
        for key, val in css:
            for idx, (name, _) in enumerate(pairs):
                if name.lower() == key.lower():
                    pairs[idx] = (key, val)
                    break
            else:
                pairs.append((key, val))
        body = "; ".join("%s: %s" % (k, v) for k, v in pairs if v != "")
        if body:
            new_raw = raw[:m.start()] + ' style="%s"' % body + raw[m.end():]
        else:
            new_raw = raw[:m.start()] + raw[m.end():]
    else:
        body = "; ".join("%s: %s" % (k, v) for k, v in css if v != "")
        if not body:
            return text
        new_raw = insert_in_tag(raw, 'style="%s"' % body)
    return text[:node.start] + new_raw + text[node.open_end:]


def set_text(text, node, value):
    if node.children:
        return None
    safe = _html.escape(value, quote=False)
    return text[:node.inner_start] + safe + text[node.inner_end:]


def _indent_of_line(text, pos):
    i = text.rfind("\n", 0, pos)
    j = i + 1
    while j < pos and text[j] in " \t":
        j += 1
    return text[i + 1:j]


def _line_head(text, pos):
    """pos 所在行的行首（缩进开始处）；元素不在行首时返回 pos 本身。"""
    i = text.rfind("\n", 0, pos) + 1
    return i if text[i:pos].strip(" \t") == "" else pos


def move(text, node, sibling, before):
    """把 node 整段挪到 sibling 前/后。

    整块搬走自己那一行的缩进和行尾换行，再按目标行的缩进落位，
    这样多挪几次也不会拼成 `</div><div>` 或越攒越多空行。
    目标是行内元素时按行内插，不额外塞换行（换行在浏览器里等于一个空格，会改观感）。
    """
    lead = _line_head(text, node.start)                  # 整行搬：连行首缩进
    tail_end = node.end + (1 if text[node.end:node.end + 1] == "\n" else 0)
    span = text[node.start:node.end]
    rest = text[:lead] + text[tail_end:]
    removed = tail_end - lead

    head = _line_head(text, sibling.start)
    own_line = head < sibling.start or (sibling.start > 0 and text[sibling.start - 1] == "\n")
    indent = _indent_of_line(text, sibling.start)
    pos = (head if own_line else sibling.start) if before else sibling.end
    if lead < pos:
        pos -= removed

    if before:
        piece = indent + span + "\n" if own_line else span
        return rest[:pos] + piece + rest[pos:]
    piece = "\n" + indent + span if own_line else span
    return rest[:pos] + piece + rest[pos:]


def clean_ids(text):
    text = re.sub(r"\sdata-ct-id\s*=\s*(\"[^\"]*\"|'[^']*')", "", text, flags=re.I)
    text = re.sub(r'\sstyle\s*=\s*(""|\'\')', "", text, flags=re.I)
    return text


def _reindent(snippet, indent):
    """把 snippet 去掉公共缩进，再统一贴上目标位置的缩进。"""
    lines = snippet.strip("\n").split("\n")
    widths = [len(l) - len(l.lstrip(" \t")) for l in lines if l.strip()]
    cut = min(widths) if widths else 0
    return "\n".join(indent + l[cut:] if l.strip() else "" for l in lines)


def delete_node(text, node):
    """删掉一个元素。独占一行的元素连整行缩进一起删，行内元素只删标签本身。"""
    start = node.start
    end = node.end
    line_start = text.rfind("\n", 0, start) + 1
    lead = text[line_start:start]
    if lead.strip(" \t") == "":
        if text[end:end + 2] == "\r\n":
            return text[:line_start] + text[end + 2:]
        if text[end:end + 1] in ("\n", ""):
            return text[:line_start] + text[end + 1:]
    return text[:start] + text[end:]


def insert(text, node, snippet, position="after"):
    """把一段 HTML 插到 node 之前 / 之后 / 内部（作为最后一个子元素）。

    整行元素：跟着 node 那一行的缩进走，不会拼成 `</div><div>` 贴在一起。
    行内元素：按行内插，不塞换行（换行在浏览器里等于一个空格，会改观感）。
    """
    snippet = snippet.strip()
    if not snippet:
        return None
    indent = _indent_of_line(text, node.start)
    body = _reindent(snippet, indent)

    if position == "before":
        head = _line_head(text, node.start)
        own_line = head < node.start or (node.start > 0 and text[node.start - 1] == "\n")
        piece = body + "\n" if own_line else body
        return text[:head] + piece + text[head:]

    if position == "after":
        own_line = text[node.end:node.end + 1] == "\n"
        tail_end = node.end + (1 if own_line else 0)
        piece = body + "\n" if own_line else body
        return text[:tail_end] + piece + text[tail_end:]

    # inside：找收尾标签前面那一行缩进，插在它前面，子元素比收尾标签再多缩进两格
    cut = text.rfind("\n", node.inner_start, node.inner_end)
    if cut >= 0 and text[cut + 1:node.inner_end].strip(" \t\r\n") == "":
        inner_indent = text[cut + 1:node.inner_end]
        piece = _reindent(snippet, inner_indent + "  ") + "\n"
        return text[:cut + 1] + piece + text[cut + 1:]
    return text[:node.inner_end] + body + text[node.inner_end:]
