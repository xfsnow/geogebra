#!/usr/bin/env python3
"""
把手册发布目录归档到 Cloudflare R2（与 cdn.snowpeak.org 共用的 cdn 桶）。

定位说明：
- 本脚本只做「异地归档备份」，**不负责 serving**。
  站点由 Cloudflare Pages 直接服务，因为 Pages 支持目录默认首页而 R2 不支持。
- 图片仅 1.9M / 395 文件（占 45M 总量的 4%），为省这点空间去改写 522 个页面的
  图片引用得不偿失，故图片仍留在 Pages，这里连同 HTML 一起整包归档。

对象键：  cdn/manual/<dist 内相对路径>
公开 URL: https://cdn.snowpeak.org/manual/...（仅当桶开启公开访问时可读）

用法（仓库根目录）：
    python3 _doc/scripts/manual/sync_r2.py                  # 默认 dry-run
    python3 _doc/scripts/manual/sync_r2.py --apply           # 真正上传
    python3 _doc/scripts/manual/sync_r2.py --apply --prefix manual/2026-08-28

注意：
- R2 凭据读 backend/.env，沿用 publish_assets_front.py 的做法。
- 需要 boto3（远程机已确认可用 1.34.46）。
- 只上传，不删除桶内多余对象。
"""

import argparse
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
DEFAULT_DIST = SCRIPT_DIR / "dist"
DEFAULT_PREFIX = "manual/"


def load_env(p: Path):
    """手动解析 backend/.env（dotenv 可能未安装）。"""
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"'))


def guess_content_type(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".htm": "text/html; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".gif": "image/gif",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".eot": "application/vnd.ms-fontobject",
        ".md": "text/markdown; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
    }.get(ext, "application/octet-stream")


def main():
    ap = argparse.ArgumentParser(description="归档手册 dist 到 R2 cdn 桶")
    ap.add_argument("--dist", default=str(DEFAULT_DIST), help="发布目录（默认脚本同级 dist）")
    ap.add_argument("--prefix", default=DEFAULT_PREFIX, help=f"对象键前缀（默认 {DEFAULT_PREFIX}）")
    ap.add_argument("--bucket", default=None, help="覆盖 R2_BUCKET")
    ap.add_argument("--apply", action="store_true", help="真正上传；不加则仅 dry-run")
    args = ap.parse_args()

    load_env(REPO_ROOT / "backend" / ".env")

    dist = Path(args.dist).resolve()
    if not dist.is_dir():
        print(f"错误：未找到发布目录 {dist}，请先运行 prepare.sh", file=sys.stderr)
        return 1

    account_id = os.environ.get("R2_ACCOUNT_ID", "")
    access_key = os.environ.get("R2_ACCESS_KEY", "")
    secret_key = os.environ.get("R2_SECRET_KEY", "")
    bucket = args.bucket or os.environ.get("R2_BUCKET", "")
    endpoint = os.environ.get("R2_ENDPOINT") or (
        f"https://{account_id}.r2.cloudflarestorage.com" if account_id else ""
    )

    missing = [
        name for name, val in [
            ("R2_ACCESS_KEY", access_key),
            ("R2_SECRET_KEY", secret_key),
            ("R2_BUCKET", bucket),
            ("R2_ENDPOINT", endpoint),
        ] if not val
    ]
    if missing:
        print(f"错误：缺少 R2 配置 {missing}（应来自 backend/.env）", file=sys.stderr)
        return 1

    files = sorted(p for p in dist.rglob("*") if p.is_file())
    total_bytes = sum(p.stat().st_size for p in files)

    prefix = args.prefix
    if prefix and not prefix.endswith("/"):
        prefix += "/"

    print("==> R2 归档计划")
    print(f"    源目录 : {dist}")
    print(f"    文件数 : {len(files)}")
    print(f"    总大小 : {total_bytes / 1024 / 1024:.1f} MB")
    print(f"    目标桶 : {bucket}")
    print(f"    前缀   : {prefix}")
    print(f"    模式   : {'APPLY（真正上传）' if args.apply else 'DRY-RUN（仅预览）'}")

    if not args.apply:
        print("\n    前 10 个对象键示例：")
        for p in files[:10]:
            print(f"      {prefix}{p.relative_to(dist).as_posix()}")
        print("\n确认后加 --apply 执行。")
        return 0

    import boto3  # 延迟导入，确保凭据已注入

    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )

    ok, failed = 0, 0
    for p in files:
        key = f"{prefix}{p.relative_to(dist).as_posix()}"
        try:
            s3.upload_file(
                str(p),
                bucket,
                key,
                ExtraArgs={"ContentType": guess_content_type(p)},
            )
            ok += 1
        except Exception as e:
            print(f"    上传失败 {key}: {e}", file=sys.stderr)
            failed += 1

    print(f"\n==> 完成: 成功 {ok}, 失败 {failed}")
    print(f"    若桶已公开，可通过 https://cdn.snowpeak.org/{prefix} 访问（仅归档，站点不走这里）")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
