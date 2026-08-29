#!/usr/bin/env bash
# 将 _doc/scripts/manual/dist 部署到 Cloudflare Pages。
#
# 前置：
#   1) 先运行 prepare.sh 生成 dist
#   2) Node 可用（本项目装在 /root/.workbuddy/binaries/node/versions/20.18.0/bin）
#   3) Cloudflare 认证，二选一：
#        export CLOUDFLARE_API_TOKEN=<token>     # 推荐，非交互
#        npx wrangler login                      # 交互登录
#
# 用法：
#   bash _doc/scripts/manual/deploy_pages.sh            # dry-run，只打印命令
#   bash _doc/scripts/manual/deploy_pages.sh --apply    # 真正部署
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$SCRIPT_DIR/dist"
PROJECT_NAME="${PROJECT_NAME:-ggb-manual}"
BRANCH="${BRANCH:-main}"

# Node 环境（远程机上的安装位置）
NODE_BIN_DIR="${NODE_BIN_DIR:-/root/.workbuddy/binaries/node/versions/20.18.0/bin}"
if [ -d "$NODE_BIN_DIR" ]; then
    export PATH="$NODE_BIN_DIR:$PATH"
fi

APPLY=0
for arg in "$@"; do
    case "$arg" in
        --apply) APPLY=1 ;;
        *) echo "未知参数: $arg" >&2; exit 1 ;;
    esac
done

if [ ! -d "$DIST" ]; then
    echo "错误：未找到 $DIST，请先运行 prepare.sh" >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "错误：未找到 node。请安装 Node 或设置 NODE_BIN_DIR" >&2
    exit 1
fi

echo "==> 待部署内容"
echo "    目录   : $DIST"
echo "    体积   : $(du -sh "$DIST" | cut -f1)"
echo "    文件数 : $(find "$DIST" -type f | wc -l)"
echo "    项目   : $PROJECT_NAME (branch=$BRANCH)"
echo ""

CMD=(npx --yes wrangler pages deploy "$DIST"
     --project-name "$PROJECT_NAME"
     --branch "$BRANCH")

if [ "$APPLY" -eq 0 ]; then
    echo "==> [DRY-RUN] 将执行："
    echo "    ${CMD[*]}"
    echo ""
    echo "确认无误后加 --apply 执行。"
    exit 0
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "警告：未设置 CLOUDFLARE_API_TOKEN，wrangler 可能进入交互登录流程。" >&2
fi

echo "==> 开始部署…"
"${CMD[@]}"

echo ""
echo "==> 部署完成。下一步验证："
echo "    bash _doc/scripts/manual/verify.sh --base-url https://$PROJECT_NAME.pages.dev"
