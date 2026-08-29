#!/usr/bin/env bash
# 验证 Cloudflare Pages 上的手册站点是否正常工作。
#
# 最关键的检查是「目录式默认首页」：
#   /manual/en/commands/3D_Commands/  →  应返回该目录下 index.htm 的内容
# 这正是 R2 做不到、必须上 Pages 的原因，务必验证。
#
# 用法：
#   bash _doc/scripts/manual/verify.sh --base-url https://ggb-manual.pages.dev
#   bash _doc/scripts/manual/verify.sh --base-url https://manual.mathplotai.com
set -uo pipefail

BASE_URL=""
while [ $# -gt 0 ]; do
    case "$1" in
        --base-url) BASE_URL="${2:-}"; shift 2 ;;
        --base-url=*) BASE_URL="${1#*=}"; shift ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

if [ -z "$BASE_URL" ]; then
    echo "错误：请指定 --base-url" >&2
    echo "用法：bash _doc/scripts/manual/verify.sh --base-url https://ggb-manual.pages.dev" >&2
    exit 1
fi

BASE_URL="${BASE_URL%/}"
PASS=0
FAIL=0

check() {
    local path="$1" expect="$2" desc="$3"
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 20 "$BASE_URL$path" 2>/dev/null || echo "000")
    if [ "$code" = "$expect" ]; then
        printf '    [OK]   %-3s  %-52s %s\n' "$code" "$path" "$desc"
        PASS=$((PASS + 1))
    else
        printf '    [FAIL] %-3s  %-52s %s (期望 %s)\n' "$code" "$path" "$desc" "$expect"
        FAIL=$((FAIL + 1))
    fi
}

echo "==> 验证站点: $BASE_URL"
echo ""

echo "-- 目录式默认首页（Pages 核心能力）--"
check "/manual/en/commands/3D_Commands/"       200 "目录 URL 自动回落 index.htm"
check "/manual/zh/"                             200 "中文首页"
check "/manual/en/"                             200 "英文首页"

echo "-- 静态资源（asset 与 manual 同级）--"
check "/asset/css/site.css"                     200 "站点 CSS"
check "/asset/js/site.js"                       200 "站点 JS"

echo "-- 图片（en/_images，zh 跨语言复用）--"
check "/manual/en/_images/16px-Menu-edit.svg.png" 200 "图片资源"

echo "-- 重定向与兜底 --"
check "/manual/index.htm"                       200 "manual 入口"
check "/this-page-should-not-exist-404check"    404 "404 兜底"

echo ""
echo "==> 结果: $PASS 通过, $FAIL 失败"

# 根路径重定向单独检查（不跟随跳转，期望 301/302）
echo ""
echo "-- 根路径重定向（不跟随）--"
ROOT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$BASE_URL/" 2>/dev/null || echo "000")
if [ "$ROOT_CODE" = "301" ] || [ "$ROOT_CODE" = "302" ] || [ "$ROOT_CODE" = "200" ]; then
    echo "    [OK]   $ROOT_CODE  / → /manual/index.htm"
else
    echo "    [WARN] $ROOT_CODE  / 未按预期重定向（可接受，manual/index.htm 自身含 meta refresh 兜底）"
fi

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "存在失败项，请检查部署。"
    exit 1
fi
echo ""
echo "全部通过。"
