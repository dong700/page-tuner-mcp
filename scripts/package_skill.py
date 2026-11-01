"""把 skill/page-tuner 打成一个可上传的 zip（只依赖标准库）

用法：
    python scripts/package_skill.py
    python scripts/package_skill.py --check-only
    python scripts/package_skill.py --out dist/my-skill.zip
"""

import argparse
import os
import re
import sys

try:
    import zipfile
except ImportError:  # pragma: no cover
    sys.exit("缺少 zipfile 模块")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SRC = os.path.join(ROOT, "skill", "page-tuner")
DEFAULT_OUT_DIR = os.path.join(ROOT, "dist")

SKIP_DIRS = {".git", "__pycache__", "node_modules", ".idea", ".vscode"}
SKIP_FILES = {".DS_Store", "Thumbs.db"}
SKIP_EXT = {".pyc", ".pyo"}

NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def fail(message):
    print("FAIL " + message)
    sys.exit(1)


def read_frontmatter(path):
    """读 SKILL.md 顶部的 --- 块，只取我们需要的几个单行字段。"""
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    if not text.startswith("---"):
        fail("SKILL.md 必须以 --- 开头（YAML frontmatter）")
    end = text.find("\n---", 3)
    if end < 0:
        fail("SKILL.md 的 frontmatter 没有闭合的 ---")
    block = text[3:end]
    data = {}
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, value = line.strip().partition(":")
        if not sep:
            continue
        key = key.strip()
        if key in data:
            continue  # 顶层字段优先，同名嵌套字段忽略
        data[key] = value.strip().strip('"').strip("'")
    return data


def validate(src):
    skill_md = os.path.join(src, "SKILL.md")
    if not os.path.isfile(skill_md):
        fail("找不到 SKILL.md：%s" % skill_md)
    meta = read_frontmatter(skill_md)

    name = meta.get("name", "")
    if not name:
        fail("frontmatter 缺少 name")
    if len(name) > 64:
        fail("name 超过 64 个字符")
    if not NAME_RE.match(name):
        fail("name 只能用小写字母、数字和单个连字符：%s" % name)
    if name != os.path.basename(src):
        fail("frontmatter 的 name=%s 必须和目录名 %s 一致" % (name, os.path.basename(src)))

    desc = meta.get("description", "")
    if not desc:
        fail("frontmatter 缺少 description")
    if len(desc) > 1024:
        fail("description 超过 1024 个字符（当前 %d）" % len(desc))

    compat = meta.get("compatibility", "")
    if compat and len(compat) > 500:
        fail("compatibility 超过 500 个字符（当前 %d）" % len(compat))

    version = meta.get("version", "")
    if not version:
        print("WARN 没有 metadata.version，输出文件名用 0.0.0")
        version = "0.0.0"
    return name, version


def iter_files(src):
    for base, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for filename in sorted(files):
            if filename in SKIP_FILES or os.path.splitext(filename)[1].lower() in SKIP_EXT:
                continue
            full = os.path.join(base, filename)
            rel = os.path.relpath(full, src)
            yield full, rel


def main():
    parser = argparse.ArgumentParser(description="打包 Agent Skill（SKILL.md + 可选脚本/参考文档）")
    parser.add_argument("--src", default=DEFAULT_SRC, help="skill 目录，默认 skill/page-tuner")
    parser.add_argument("--out", help="输出 zip 路径，默认 dist/<name>-skill-<version>.zip")
    parser.add_argument("--check-only", action="store_true", help="只校验，不打包")
    args = parser.parse_args()

    src = os.path.abspath(args.src)
    name, version = validate(src)
    files = list(iter_files(src))
    if not files:
        fail("skill 目录是空的")

    for _, rel in files:
        if rel.startswith(".") or ".." in rel:
            fail("非法路径：%s" % rel)

    print("OK   %s v%s · %d 个文件" % (name, version, len(files)))
    for _, rel in files:
        print("     %s" % rel)

    if args.check_only:
        return

    out = os.path.abspath(args.out or os.path.join(
        DEFAULT_OUT_DIR, "%s-skill-%s.zip" % (name, version)))
    os.makedirs(os.path.dirname(out), exist_ok=True)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        # 统一用 <name>/ 作为根，和 Agensi / Agent Skills 的目录约定一致
        for full, rel in files:
            zf.write(full, arcname="%s/%s" % (name, rel.replace(os.sep, "/")))

    size = os.path.getsize(out)
    print("\nzip  %s  (%.1f KB)" % (out, size / 1024.0))
    if size > 10 * 1024 * 1024:
        print("WARN 超过 10 MB，多数市场有上传上限，考虑删掉大资源")


if __name__ == "__main__":
    main()
