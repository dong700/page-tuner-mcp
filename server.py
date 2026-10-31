"""页面精修器 · 本地服务

python server.py [page.html] [--port 8766]

- GET  /             编辑器外壳（左 iframe 预览 + 右属性面板）
- GET  /preview      原始页面 + 注入编辑脚本（供 iframe 加载）
- GET  /api/meta     当前文件名 / 大小 / mtime / 同目录还有哪些页面
- POST /api/open     切换到同目录（或子目录）下的另一个 html，继续改
- POST /api/save     原子写回页面文件（自动剔除注入脚本）

只处理「单文件静态 HTML」。带构建产物、外部打包脚本的页面不在范围内。
一个站点的多个页面放在同一个目录树里，切页只在起始页所在目录内进行。
"""

import argparse
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
MAX_BODY = 8 * 1024 * 1024
LOCK = threading.Lock()

# 注入脚本：iframe 里所有编辑能力都由它提供，导出时会被剔除
INJECT = '<script src="/static/inject.js" id="ct-inject"></script>'
INJECT_RE = re.compile(r'<script[^>]*id="ct-inject"[^>]*>\s*</script>\s*', re.I)

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    page_path = ""
    base_dir = ""

    def log_message(self, *_args):
        pass

    # ---------------------------------------------------------------- 工具

    def _pages(self, limit=40):
        """起始页所在目录树里的 html 列表，用来切页。只列 html，跳过隐藏目录。"""
        found = []
        for root, dirs, files in os.walk(self.base_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in files:
                if not name.lower().endswith((".html", ".htm")):
                    continue
                full = os.path.join(root, name)
                if os.path.abspath(full).startswith(os.path.abspath(STATIC) + os.sep):
                    continue
                rel = os.path.relpath(full, self.base_dir).replace(os.sep, "/")
                found.append(rel)
                if len(found) >= limit:
                    break
            if len(found) >= limit:
                break
        return sorted(found, key=lambda p: (p.count("/"), p.lower()))

    def _meta(self):
        st = os.stat(self.page_path)
        return {"file": os.path.relpath(self.page_path, self.base_dir).replace(os.sep, "/"),
                "size": st.st_size, "mtime": st.st_mtime, "pages": self._pages()}

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _html(self, code, text):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _read_page(self):
        with open(self.page_path, encoding="utf-8") as handle:
            return handle.read()

    def _serve_static(self, rel):
        target = os.path.normpath(os.path.join(STATIC, rel))
        if not target.startswith(STATIC) or not os.path.isfile(target):
            self.send_error(404)
            return
        ext = os.path.splitext(target)[1].lower()
        with open(target, "rb") as handle:
            body = handle.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        # 本地工具，禁掉缓存，避免改了代码刷新还是旧版本
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.end_headers()
        self.wfile.write(body)

    # ---------------------------------------------------------------- 路由

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/preview":
            try:
                html = self._read_page()
            except OSError as exc:
                self._html(500, f"<pre>读不到页面：{exc}</pre>")
                return
            # 注入脚本放在 </body> 前；没有 body 就追加到末尾
            if re.search(r"</body>", html, re.I):
                html = re.sub(r"</body>", INJECT + "\n</body>", html, count=1, flags=re.I)
            else:
                html = html + "\n" + INJECT
            self._html(200, html)
            return
        if path == "/api/meta":
            try:
                self._json(200, self._meta())
            except OSError as exc:
                self._json(500, {"error": str(exc)})
            return
        if path == "/api/health":
            self._json(200, {"ok": True, "page": os.path.basename(self.page_path)})
            return
        if path in ("/", "/index.html"):
            self._serve_static("index.html")
            return
        if path.startswith("/static/"):
            self._serve_static(path[len("/static/"):])
            return
        self._serve_static(path.lstrip("/"))

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/open":
            doc = self._read_body()
            name = doc.get("file") if isinstance(doc, dict) else None
            if not isinstance(name, str) or not name.strip():
                self._json(400, {"error": "缺少 file 字段"})
                return
            name = name.strip().replace("\\", "/").lstrip("/")
            if ".." in name.split("/"):
                self._json(400, {"error": "只允许站内相对路径"})
                return
            target = os.path.normpath(os.path.join(self.base_dir, name))
            if not target.lower().endswith((".html", ".htm")):
                self._json(400, {"error": "只能切到 html 页面"})
                return
            if not os.path.isfile(target):
                self._json(404, {"error": "没有这个页面：%s" % name})
                return
            if not os.path.abspath(target).startswith(os.path.abspath(self.base_dir) + os.sep):
                self._json(400, {"error": "只允许在这个站点的目录里切页"})
                return
            with LOCK:
                Handler.page_path = os.path.abspath(target)
                self.page_path = Handler.page_path
            try:
                self._json(200, self._meta())
            except OSError as exc:
                self._json(500, {"error": str(exc)})
            return
        if path == "/api/changes":
            doc = self._read_body()
            if not isinstance(doc, dict) or not isinstance(doc.get("entries"), list):
                self._json(400, {"error": "缺少 entries 数组"})
                return
            payload = {
                "page": os.path.basename(self.page_path),
                "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "entries": doc["entries"][:300],
            }
            body = json.dumps(payload, ensure_ascii=False, indent=2)
            target = self.page_path + ".changes.json"
            with LOCK:
                tmp = target + ".tmp"
                with open(tmp, "w", encoding="utf-8") as handle:
                    handle.write(body)
                os.replace(tmp, target)
            self._json(200, {"ok": True, "file": os.path.basename(target),
                             "bytes": len(body.encode("utf-8")),
                             "count": len(payload["entries"])})
            return
        if path == "/api/selection":
            doc = self._read_body()
            if not isinstance(doc, dict) or not isinstance(doc.get("text"), str):
                self._json(400, {"error": "缺少 text 字段"})
                return
            payload = dict(doc)
            payload["page"] = os.path.basename(self.page_path)
            payload["saved_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            body = json.dumps(payload, ensure_ascii=False, indent=2)
            target = self.page_path + ".selection.json"
            with LOCK:
                tmp = target + ".tmp"
                with open(tmp, "w", encoding="utf-8") as handle:
                    handle.write(body)
                os.replace(tmp, target)
            self._json(200, {"ok": True, "file": os.path.basename(target),
                             "bytes": len(body.encode("utf-8"))})
            return
        if path != "/api/save":
            self.send_error(404)
            return
        doc = self._read_body()
        if not isinstance(doc, dict) or not isinstance(doc.get("html"), str):
            self._json(400, {"error": "缺少 html 字段"})
            return
        html = INJECT_RE.sub("", doc["html"])
        if "</html>" not in html.lower():
            html = html + "\n"
        with LOCK:
            tmp = self.page_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                handle.write(html)
            os.replace(tmp, self.page_path)
        self._json(200, {"ok": True, "bytes": len(html.encode("utf-8"))})


def main():
    parser = argparse.ArgumentParser(description="页面精修器")
    parser.add_argument("page", nargs="?", default=os.path.join(BASE, "sample", "landing.html"))
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()

    page_path = os.path.abspath(args.page)
    if not os.path.isfile(page_path):
        sys.exit(f"找不到页面文件：{page_path}")

    Handler.page_path = page_path
    Handler.base_dir = os.path.dirname(page_path)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        sys.exit(f"端口 {args.port} 起不来（{exc}）。换一个：--port 8767")

    print(f"页面精修器 → http://127.0.0.1:{args.port}/   编辑文件：{page_path}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
