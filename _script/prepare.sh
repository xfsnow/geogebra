#!/usr/bin/env bash
# 构建 GeoGebra 手册的 Cloudflare Pages 发布目录。
#
# 关键约束：asset/ 必须与 manual/ 同级。
#   manual/en/Algebra_View/index.htm 内引用 ../../../asset/css/site.css，
#   即从发布根起算，故两者在 dist 下并列。
#
# 来源探测顺序：
#   1. $MANUAL_REPO_DIR/manual  （迁移后的独立仓库，默认 /srv/ggb-manual）
#   2. $REPO_ROOT/frontend/manual（迁移前的过渡期来源）
#   asset/ 始终取自主仓库 frontend/asset（后端 templates.py 也在用它，不迁出）
#
# 用法：
#   bash _doc/scripts/manual/prepare.sh
#   MANUAL_REPO_DIR=/path/to/manual-repo bash _doc/scripts/manual/prepare.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DIST="$SCRIPT_DIR/dist"

MANUAL_REPO_DIR="${MANUAL_REPO_DIR:-/srv/ggb-manual}"

echo "==> 仓库根目录 : $REPO_ROOT"
echo "==> 发布目录   : $DIST"

# ---- 探测 manual 来源 ----
if [ -d "$MANUAL_REPO_DIR/manual" ]; then
    MANUAL_SRC="$MANUAL_REPO_DIR/manual"
    echo "==> manual 来源 : 独立仓库 $MANUAL_SRC"
elif [ -d "$REPO_ROOT/frontend/manual" ]; then
    MANUAL_SRC="$REPO_ROOT/frontend/manual"
    echo "==> manual 来源 : 主仓库 $MANUAL_SRC（尚未迁移，过渡期）"
else
    echo "错误：未找到 manual 目录。" >&2
    echo "      已尝试：$MANUAL_REPO_DIR/manual 与 $REPO_ROOT/frontend/manual" >&2
    exit 1
fi

ASSET_SRC="$REPO_ROOT/frontend/asset"
if [ ! -d "$ASSET_SRC" ]; then
    echo "错误：未找到 $ASSET_SRC" >&2
    exit 1
fi

# ---- 构建 ----
echo "==> 清理旧的发布目录"
rm -rf "$DIST"
mkdir -p "$DIST"

echo "==> 复制 manual/"
cp -a "$MANUAL_SRC" "$DIST/manual"

echo "==> 复制 asset/（与 manual 同级）"
cp -a "$ASSET_SRC" "$DIST/asset"

# manual/index.htm 本身已含 meta refresh + JS 跳转，
# 这里再放 Pages 层的 _redirects，让根路径在服务端直接 302，不依赖 JS。
echo "==> 生成 _redirects"
cat > "$DIST/_redirects" <<'EOF'
/           /manual/index.htm    302
/manual     /manual/index.htm    302
/manual/    /manual/index.htm    302
EOF

echo "==> 生成 404.html"
cat > "$DIST/404.html" <<'EOF'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="2;url=/manual/index.htm">
<title>页面未找到 - GeoGebra 手册</title>
</head>
<body>
<p>页面未找到，正在跳转到 <a href="/manual/index.htm">手册首页</a>…</p>
</body>
</html>
EOF

# ---- 自检 ----
echo ""
echo "==> 自检"
MISSING=0
for f in "manual/index.htm" "manual/zh/index.htm" "manual/en/index.htm" \
         "asset/css/site.css" "asset/js/site.js" "_redirects" "404.html"; do
    if [ -f "$DIST/$f" ]; then
        echo "    [OK]   $f"
    else
        echo "    [MISS] $f"
        MISSING=$((MISSING + 1))
    fi
done

if [ "$MISSING" -gt 0 ]; then
    echo "错误：$MISSING 个关键文件缺失" >&2
    exit 1
fi

echo ""
echo "==> 发布目录就绪"
echo "    体积   : $(du -sh "$DIST" | cut -f1)"
echo "    文件数 : $(find "$DIST" -type f | wc -l)"
echo "    目录数 : $(find "$DIST" -type d | wc -l)"
echo ""
echo "下一步：bash _doc/scripts/manual/deploy_pages.sh"
