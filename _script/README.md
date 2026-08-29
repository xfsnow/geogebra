# 手册相关脚本（译制 / 修正 / 部署）

本目录集中存放**所有与 GeoGebra 命令手册相关的脚本**，原分散在 `_doc/scripts/`
（译制、修正类）与 `_doc/deploy/manual/`（部署类），2026-08-29 合并至此。

- **当前线上手册**：<https://www.snowpeak.org/geogebra/>（GitHub Pages，2026-08-29 上线）
- `frontend/manual/` 已停止随主仓库分发，站内只保留外链入口（`MANUAL_BASE_URL`）
- 完整迁移方案与分步手册见 [`_doc/manual-pages-migration.md`](../../manual-pages-migration.md)

## 一句话背景

手册是 Antora 生成的静态站点，全站 **70283 处**「目录式 URL」（`/xxx/` → `xxx/index.htm`）。
Cloudflare **R2 是纯对象存储，不支持目录默认首页**，所以必须上 **Pages**。

## 脚本清单

### 译制 / 修正类（原 `_doc/scripts/`）

| 脚本 | 作用 |
|---|---|
| `translate_html.py` | 手册英文页汉化（单文件 / 批量，支持 gemini / qwen / glm） |
| `run_translate.py` | Windows 一键翻译启动器（自动读注册表 QWEN_API_KEY） |
| `fix_links.py` | `/docs/manual/en/` → `/docs/manual/zh/` 导航链接切换 |
| `fix_icon_links.py` | 修复中文目录页丢失的图标链接 |
| `fix_version_menu.py` | 修复 zh/ 页版本菜单 |
| `fix_version_menu_en.py` | 修复 en/ 页版本菜单 |
| `fix_command_names.py` | 修复 zh 命令 / 工具链接文字被译错 |
| `replace_tppabs.py` | 把 `javascript:` href 还原为 `tppabs` 真实地址 |
| `replace_geogebra_github_links.py` | `geogebra.github.io/...` → 站内相对路径 |
| `remove_cse.py` | 移除抓取残留的 Google CSE 脚本 |
| `update_highlight.py` | 统一 highlight.js CDN 引用 |
| `update_mathjax.py` | 统一 MathJax CDN 引用 |
| `fetch_missing_images.py` | 从官方站补抓缺失图片 |
| `find_javascript_href.py` | 扫描残留 `javascript:` 链接 |
| `translate_log.txt` | 翻译批次日志（过程产物） |

> 以上脚本的详细参数与环境变量见 [`_doc/scripts/README.md`](../README.md) 中带
> `manual/` 前缀的同名章节。

### 部署类

| 脚本 | 作用 | 默认行为 |
|---|---|---|
| `prepare.sh` | 构建发布目录 `dist/`（manual + asset 同级） | 直接执行，仅本地构建 |
| `deploy_pages.sh` | 部署到 Pages 项目 `ggb-manual` | 需 `--apply` |
| `verify.sh` | 验证目录首页 / 资源 / 图片 / 404 | 只读 |
| `sync_r2.py` | 归档 dist 到 R2 `cdn` 桶前缀 `manual/` | `--dry-run` 默认 |
| `detach_local.sh` | 手册迁出主仓库到独立 git 仓库 | `--dry-run` 默认 |
| `rebuild_registry.py` | 重建 RAG 命令索引 JSON | 需 `--apply` |
| `wrangler.toml` | Pages 项目配置 | - |

## 典型流程

```bash
# 阶段 0-2：不影响现网
bash _doc/scripts/manual/prepare.sh
bash _doc/scripts/manual/deploy_pages.sh --apply
bash _doc/scripts/manual/verify.sh --base-url https://ggb-manual.pages.dev

# 阶段 3：Pages 控制台绑定 manual.mathplotai.com（nginx 零改动）

# 阶段 4：确认线上可用后再迁出本地文件
bash _doc/scripts/manual/detach_local.sh         # 先看计划
bash _doc/scripts/manual/detach_local.sh --apply
```

## 两个易踩的坑

1. **`asset/` 必须与 `manual/` 同级。**
   页面里是 `../../../asset/css/site.css`，从 `manual/en/<页>/index.htm` 起算正好回到发布根。
   全站 0 处根绝对路径引用，所以挂独立子域名也能正常工作。

2. **阶段顺序不能颠倒。**
   必须先部署并验证 Pages，再执行 `detach_local.sh`，
   否则手册会陷入「线上没有、本地也没了」的空窗。

## RAG 依赖已解除

`backend/app/rag/command_registry.py` 先读 `backend/data/command_registry.json`，
**只有 JSON 缺失时**才回源读 `frontend/manual/`。该 JSON 已入库（502 条命令），
故迁走 `manual/` 不影响 RAG。手册内容更新后用 `rebuild_registry.py` 重建即可。
