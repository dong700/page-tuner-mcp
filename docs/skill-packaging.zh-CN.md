# 把 page-tuner 上架成 Agent Skill（SKILL.md 打包说明）

> 目标：做出一个能提交到 Agensi（以及任何支持 Agent Skills 的客户端）的 zip。

## 1. 先分清两层

| 层 | 是什么 | 谁负责 |
|---|---|---|
| **MCP** | 12 个工具，能读写本地单文件 HTML | `mcp_server.py`，用户装在自己机器上 |
| **Skill** | 一份 `SKILL.md`，告诉 agent「什么时候该用 page-tuner、怎么调、哪些不能做」 | 这次打包的东西 |

Agensi 卖的是 Skill，不是 MCP。用户装上 Skill 后，仍然需要按仓库 README 配置 page-tuner MCP，所以 listing 文案里要明确写：

> Requires the page-tuner MCP server (Python 3.9+, zero dependencies).

## 2. 目录结构

```
skill/page-tuner/
├── SKILL.md                 # 必需：frontmatter + 指令
└── references/
    └── tools.md             # 按需加载的 12 工具详表
```

打包后的 zip：

```
page-tuner-skill-1.6.0.zip
└── page-tuner/
    ├── SKILL.md
    └── references/tools.md
```

zip 里只放 skill 自己的文件，**不要**放整个仓库（`.git`、`__pycache__`、`dist`、侧车 JSON 都不该进去）。

## 3. frontmatter 规则

`SKILL.md` 顶部必须是 YAML：

```yaml
---
name: page-tuner
description: Human-in-the-loop polishing for single-file HTML pages. ...
license: MIT
compatibility: Requires Python 3.9+ and the page-tuner MCP server ...
metadata:
  author: dong700
  version: "1.6.0"
  repository: https://github.com/dong700/page-tuner-mcp
---
```

| 字段 | 要求 |
|---|---|
| `name` | 1–64 字符，只允许小写字母/数字/单个连字符，**必须和目录名一致** |
| `description` | ≤1024 字符；写清「做什么 + 什么时候用」，带上 `HTML`、`visual editor`、`spacing`、`lasso` 这类关键词 |
| `license` | 写 `MIT` 即可 |
| `compatibility` | ≤500 字符；写清 Python 版本和依赖 MCP |
| `metadata` | 字符串键值对；至少放 `author`、`version`、`repository` |

正文控制在 500 行以内，细节放 `references/`，agent 只在需要时才读。

## 4. 打包

仓库自带校验 + 打包脚本（纯标准库）：

```powershell
python scripts/package_skill.py --check-only   # 只校验 frontmatter 和目录名
python scripts/package_skill.py                # 输出 dist/page-tuner-skill-1.6.0.zip
```

脚本会：

- 校验 `name` 与目录名一致、`description` / `compatibility` 长度、命名规则
- 跳过 `.git`、`__pycache__`、`.pyc` 等
- 统一用 `page-tuner/` 作为 zip 根目录
- 打印文件清单和体积（超过 10 MB 会提示）

不想用脚本也可以（PowerShell）：

```powershell
Compress-Archive -Path skill\page-tuner -DestinationPath dist\page-tuner-skill-1.6.0.zip -Force
```

`dist/` 已经在 `.gitignore` 里，打包产物不进仓库。

## 5. 提交到 Agensi

1. 打开 https://www.agensi.io/dashboard/submit ，登录创作者账号
2. 上传 `dist/page-tuner-skill-1.6.0.zip`
3. 填 listing：标题、短描述、分类（建议 `Design` / `Developer Tools`）、价格（免费填 0）
4. 过审流程：8 项自动安全扫描 → AI 审核意图 → 人工复核，通常 24–48 小时
5. 通过后 skill 会出现在市场页，并通过他们的 MCP 分发给 Claude Code、Cursor、Copilot 等 agent

## 6. 定价建议

| 方案 | 做法 | 适合 |
|---|---|---|
| 免费引流版 | 价格 0，只换曝光 | 现在，主仓库保持 MIT |
| 付费增强包 | 把「行业模板 + 案例 + 一键检查脚本」放进 `assets/`，代码仍然开源 | 以后 |
| 卖服务 | listing 写「页面精修/配置服务」，按次收费 | 有人真的用起来之后 |

不要卖 MIT 代码本身——防不住复制；也不要签独家、不要给 GitHub 协作者权限。Agensi 抽 30%，创作者拿 70%，他们作为 merchant of record 处理税费。

## 7. 版本升级

1. 改 `SKILL.md` 正文和 `metadata.version`（例如 `1.7.0`）
2. `python scripts/package_skill.py`，`dist/` 里保留旧 zip 方便回滚
3. Agensi 后台提交新版本
4. 同时给 GitHub 打 tag：`git tag v1.7.0 && git push origin v1.7.0`

## 8. 提交前检查清单

- [ ] zip 根目录是 `page-tuner/`，里面直接是 `SKILL.md`
- [ ] `name` 和目录名一致，全是小写
- [ ] `description` 里写了「什么时候用」和「依赖 page-tuner MCP」
- [ ] 没有 `.git`、`__pycache__`、`dist`、`*.changes.json`、`*.selection.json`
- [ ] 文档里没有本机绝对路径（用相对路径或仓库链接）
- [ ] `license: MIT` 与实际仓库一致
- [ ] 体积小于 10 MB

## 9. 授权与合规

- Skill 内容用 MIT，和主仓库一致；Agensi 获得的是**分发 zip** 的授权，不是仓库所有权
- 不上传用户数据、不放密钥、不写 `~/.ssh` 之类的路径
- 主仓库继续维护，市场只是渠道；有人提 Issue 仍然在 GitHub 处理
