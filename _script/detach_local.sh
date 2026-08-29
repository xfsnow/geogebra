#!/usr/bin/env bash
# 把 frontend/manual/ 从主仓库迁出到独立 git 仓库。
#
# ⚠️ 前置条件（脚本会检查）：
#   1. 手册已成功部署到 Cloudflare Pages 并通过 verify.sh
#      —— 否则会出现「线上没有、本地也没了」的空窗
#   2. backend/data/command_registry.json 存在且有效
#      —— RAG 运行时读该 JSON，不读 manual/，但必须有它兜底
#
# 做了什么：
#   1. 在 $MANUAL_REPO_DIR（默认 /srv/ggb-manual）建独立 git 仓库，移入 manual/ 并提交
#   2. 主仓库 git rm -r --cached frontend/manual（停止跟踪）+ 删除磁盘文件
#   3. .gitignore 追加 frontend/manual/
#   4. 写 .vscode/settings.json 的 files.watcherExclude（本机配置，.vscode/ 已被 git 忽略）
#
# 用法：
#   bash _doc/scripts/manual/detach_local.sh              # dry-run，只打印计划
#   bash _doc/scripts/manual/detach_local.sh --apply      # 真正执行
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

MANUAL_REPO_DIR="${MANUAL_REPO_DIR:-/srv/ggb-manual}"
MANUAL_SRC="$REPO_ROOT/frontend/manual"
REGISTRY_JSON="$REPO_ROOT/backend/data/command_registry.json"
GITIGNORE="$REPO_ROOT/.gitignore"

APPLY=0
for arg in "$@"; do
    case "$arg" in
        --apply) APPLY=1 ;;
        *) echo "未知参数: $arg" >&2; exit 1 ;;
    esac
done

echo "==> manual 迁出计划"
echo "    主仓库       : $REPO_ROOT"
echo "    来源         : $MANUAL_SRC"
echo "    目标独立仓库 : $MANUAL_REPO_DIR"
echo "    模式         : $([ "$APPLY" -eq 1 ] && echo 'APPLY（真正执行）' || echo 'DRY-RUN（仅预览）')"
echo ""

# ---------- 前置检查 ----------
echo "==> 前置检查"
ABORT=0

if [ ! -d "$MANUAL_SRC" ]; then
    echo "    [FAIL] $MANUAL_SRC 不存在（是否已迁移过？）"
    ABORT=1
else
    echo "    [OK]   manual 源目录存在 ($(du -sh "$MANUAL_SRC" | cut -f1), $(find "$MANUAL_SRC" -type f | wc -l) 文件)"
fi

if [ ! -f "$REGISTRY_JSON" ]; then
    echo "    [FAIL] $REGISTRY_JSON 不存在 —— RAG 会静默降级，必须先生成"
    ABORT=1
else
    CNT=$(python3 -c "import json;print(json.load(open('$REGISTRY_JSON')).get('count',0))" 2>/dev/null || echo "?")
    echo "    [OK]   RAG 缓存存在，命令数 = $CNT"
fi

if [ -e "$MANUAL_REPO_DIR" ]; then
    echo "    [FAIL] 目标目录 $MANUAL_REPO_DIR 已存在，避免覆盖，请先处理"
    ABORT=1
else
    echo "    [OK]   目标目录未被占用"
fi

if ! cd "$REPO_ROOT" 2>/dev/null || [ ! -d "$REPO_ROOT/.git" ]; then
    echo "    [FAIL] $REPO_ROOT 不是 git 仓库"
    ABORT=1
else
    echo "    [OK]   主仓库 git 正常，当前分支 $(git rev-parse --abbrev-ref HEAD)"
fi

if [ "$ABORT" -ne 0 ]; then
    echo ""
    echo "前置检查未通过，中止。"
    exit 1
fi

# ---------- 计划预览 ----------
cat <<EOF

==> 将执行以下步骤：
    1. 备份 $REGISTRY_JSON
    2. mkdir -p $MANUAL_REPO_DIR && git init
    3. 复制 $MANUAL_SRC → $MANUAL_REPO_DIR/manual（先复制后删除，确保数据安全）
    4. 校验复制完整性（文件数比对）
    5. 独立仓库 git add/commit
    6. 主仓库 git rm -r --cached frontend/manual && rm -rf $MANUAL_SRC
    7. .gitignore 追加 frontend/manual/
    8. 写 .vscode/settings.json（files.watcherExclude）

EOF

if [ "$APPLY" -eq 0 ]; then
    echo "==> [DRY-RUN] 以上是计划，未做任何改动。"
    echo "    确认「手册已在 Pages 上线并验证通过」后，加 --apply 执行。"
    exit 0
fi

# ---------- 执行 ----------
echo "==> [1/8] 备份 RAG 缓存"
cp -a "$REGISTRY_JSON" "$REGISTRY_JSON.bak.$(date +%Y%m%d%H%M%S)"
echo "    已备份"

echo "==> [2/8] 初始化独立仓库"
mkdir -p "$MANUAL_REPO_DIR"
git -C "$MANUAL_REPO_DIR" init -q
echo "    已 git init: $MANUAL_REPO_DIR"

echo "==> [3/8] 复制 manual/（先复制，校验后再删源）"
cp -a "$MANUAL_SRC" "$MANUAL_REPO_DIR/manual"
SRC_CNT=$(find "$MANUAL_SRC" -type f | wc -l)
DST_CNT=$(find "$MANUAL_REPO_DIR/manual" -type f | wc -l)
echo "    源文件数 $SRC_CNT → 目标文件数 $DST_CNT"

echo "==> [4/8] 校验复制完整性"
if [ "$SRC_CNT" -ne "$DST_CNT" ]; then
    echo "    [FAIL] 文件数不一致，中止（源数据未删除，安全）"
    exit 1
fi
echo "    [OK] 文件数一致"

echo "==> [5/8] 独立仓库提交"
cat > "$MANUAL_REPO_DIR/README.md" <<'EOF'
# GeoGebra 手册静态站点（独立仓库）

从主仓库 `ggb` 迁出，低频更新，保留 git 版本管理。

- 源目录：`manual/`（Antora 生成，含 `en/`、`zh/`）
- 线上托管：Cloudflare Pages 项目 `ggb-manual`，域名 `manual.mathplotai.com`
- 部署流程见主仓库 `_doc/manual-pages-migration.md`
EOF
git -C "$MANUAL_REPO_DIR" add -A
git -C "$MANUAL_REPO_DIR" -c user.name=ggb-migrate -c user.email=migrate@local \
    commit -q -m "chore: 手册静态站点从主仓库 ggb 迁出"
echo "    已提交：$(git -C "$MANUAL_REPO_DIR" rev-parse --short HEAD)"

echo "==> [6/8] 主仓库停止跟踪并删除磁盘文件"
git -C "$REPO_ROOT" rm -r --cached -q frontend/manual
rm -rf "$MANUAL_SRC"
echo "    已 git rm --cached 并删除 $MANUAL_SRC"

echo "==> [7/8] 更新 .gitignore"
if grep -qxF "frontend/manual/" "$GITIGNORE"; then
    echo "    已存在，跳过"
else
    printf '\n# 手册静态站点已迁至独立仓库（/srv/ggb-manual）；线上由 Cloudflare Pages 托管\n# 详见 _doc/manual-pages-migration.md\nfrontend/manual/\n' >> "$GITIGNORE"
    echo "    已追加 frontend/manual/"
fi

echo "==> [8/8] 配置 VS Code watcherExclude（本机配置）"
VSCODE_DIR="$REPO_ROOT/.vscode"
mkdir -p "$VSCODE_DIR"
cat > "$VSCODE_DIR/settings.json" <<'EOF'
{
  "files.watcherExclude": {
    "**/.git/objects/**": true,
    "**/.git/subtree-cache/**": true,
    "**/node_modules/**": true,
    "**/backend/**/__pycache__/**": true,
    "**/backend/**/*.pyc": true,
    "**/_doc/scripts/manual/dist/**": true
  },
  "search.exclude": {
    "**/_doc/scripts/manual/dist": true
  }
}
EOF
echo "    已写入 $VSCODE_DIR/settings.json"

echo ""
echo "==> 迁移完成"
echo "    独立仓库 : $MANUAL_REPO_DIR"
echo "    主仓库   : $(cd "$REPO_ROOT" && git rev-parse --short HEAD) （含未提交的删除与 .gitignore 变更）"
echo ""
echo "==> 后续："
echo "    1. 复核变更： git -C $REPO_ROOT status"
echo "    2. 提交主仓库：git -C $REPO_ROOT add -A && git -C $REPO_ROOT commit -m 'chore: 手册静态站点迁出至独立仓库'"
echo "    3. 重新构建发布目录：bash _doc/scripts/manual/prepare.sh（此时应取 /srv/ggb-manual/manual）"
