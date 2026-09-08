#!/usr/bin/env python3
"""
重建 RAG 命令索引缓存 backend/data/command_registry.json。

⚠️ 已失效（2026-09-08）
----------------------
backend/app/rag/command_registry.py 与 /rag/command* 四端点已下线删除，本脚本依赖
「符号链接 + import CommandRegistry 复用业务解析逻辑」的前提不再成立。
**请改用同目录的 command_registry.py**（自包含解析 + --apply 落盘 + --get/--search 查询）。

为什么需要它
------------
backend/app/rag/command_registry.py 的逻辑是「先读缓存、缺失才回源」：

    def _load_or_build(self):
        if not self._load():          # 读 ./data/command_registry.json
            self._build_from_html()   # 仅当 JSON 不存在时才读 frontend/manual/

所以只要 JSON 在，RAG 运行时根本不读 manual/ —— 这正是手册能安全迁出的前提。
但回源路径写死为 Path("../frontend/manual/zh/commands")（依赖 CWD），
手册迁到独立仓库后该路径失效，重建索引就需要本脚本。

实现方式（避免解析逻辑漂移）
----------------------------
不复制粘贴解析代码，而是**复用业务代码本身**：
在 backend/ 下把 ../frontend/manual 符号链接到新的手册仓库，
删掉旧 JSON 后 import CommandRegistry，让官方逻辑自己重新构建并落盘。
这样永远与 backend 的解析规则保持一致。

用法（仓库根目录）：
    python3 _doc/scripts/manual/rebuild_registry.py                       # dry-run
    python3 _doc/scripts/manual/rebuild_registry.py --apply               # 真正重建
    python3 _doc/scripts/manual/rebuild_registry.py --apply \
        --manual-dir /srv/ggb-manual                                     # 指定手册仓库

注意：
- 需能 import backend 的 app 包（依赖 backend/requirements.txt 已安装）。
- 会自动备份旧 JSON 为 .bak.<时间戳>；重建后比对命令数，明显变少则告警。
- 重建完记得把 JSON 提交进 git（它就是 RAG 的运行时数据源）。
"""

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
REGISTRY_JSON = BACKEND_DIR / "data" / "command_registry.json"
DEFAULT_MANUAL_DIR = "/srv/ggb-manual"


def resolve_manual_commands(manual_dir: str) -> Path:
    """定位 <manual_dir>/manual/zh/commands。兼容两种布局。"""
    base = Path(manual_dir).expanduser().resolve()
    for candidate in (base / "manual" / "zh" / "commands", base / "zh" / "commands"):
        if candidate.is_dir():
            return candidate
    raise SystemExit(
        f"错误：在 {base} 下未找到 manual/zh/commands 或 zh/commands\n"
        f"      请检查 --manual-dir 指向的是手册仓库根目录"
    )


def main():
    ap = argparse.ArgumentParser(description="重建 RAG 命令索引 JSON")
    ap.add_argument("--manual-dir", default=os.environ.get("MANUAL_REPO_DIR", DEFAULT_MANUAL_DIR),
                    help=f"手册仓库根目录（默认 {DEFAULT_MANUAL_DIR}）")
    ap.add_argument("--min-count", type=int, default=400,
                    help="重建后命令数低于此值则告警（当前基线 502；默认 400）")
    ap.add_argument("--apply", action="store_true", help="真正重建；不加则仅 dry-run")
    args = ap.parse_args()

    commands_dir = resolve_manual_commands(args.manual_dir)

    print("==> 重建 RAG 命令索引")
    print(f"    仓库根目录 : {REPO_ROOT}")
    print(f"    手册来源   : {commands_dir}")
    print(f"    输出 JSON  : {REGISTRY_JSON}")
    print(f"    模式       : {'APPLY（真正重建）' if args.apply else 'DRY-RUN（仅预览）'}")

    old_count = None
    if REGISTRY_JSON.exists():
        try:
            old_count = json.loads(REGISTRY_JSON.read_text(encoding="utf-8")).get("count")
            print(f"    现有命令数 : {old_count}")
        except Exception as e:
            print(f"    现有 JSON 无法解析（将继续）: {e}")

    # command_registry.py 用相对路径 ../frontend/manual/zh/commands，
    # 相对的是**进程工作目录**，所以必须 chdir 到 backend/ 下才能对上。
    expect_link_parent = REPO_ROOT / "frontend"
    expect_link = expect_link_parent / "manual"

    plan_link = False
    if (REPO_ROOT / "frontend" / "manual" / "zh" / "commands").is_dir() and \
            (REPO_ROOT / "frontend" / "manual" / "zh" / "commands").resolve() == commands_dir:
        print("    回源路径   : 已指向目标手册目录，无需符号链接")
    elif expect_link.exists() or expect_link.is_symlink():
        raise SystemExit(
            f"错误：{expect_link} 已存在但与目标不一致。\n"
            f"      目标: {commands_dir.parent.parent}\n"
            f"      请手动处理该目录后再运行（不会自动删除，避免误删数据）。"
        )
    else:
        plan_link = True
        print(f"    回源路径   : 将临时建符号链接 {expect_link} -> {commands_dir.parent.parent}")

    if not args.apply:
        print("\n==> [DRY-RUN] 以上是计划，未做任何改动。确认后加 --apply。")
        return 0

    # ---------- 执行 ----------
    backup = None
    if REGISTRY_JSON.exists():
        backup = REGISTRY_JSON.with_suffix(REGISTRY_JSON.suffix + f".bak.{int(time.time())}")
        shutil.copy2(REGISTRY_JSON, backup)
        print(f"\n==> 已备份旧 JSON -> {backup.name}")
        REGISTRY_JSON.unlink()
        print("==> 已删除旧 JSON，触发回源重建")

    created_link = False
    cwd = os.getcwd()
    try:
        if plan_link:
            expect_link_parent.mkdir(parents=True, exist_ok=True)
            os.symlink(commands_dir.parent.parent, expect_link)
            created_link = True
            print(f"==> 已建符号链接 {expect_link} -> {commands_dir.parent.parent}")

        os.chdir(BACKEND_DIR)
        sys.path.insert(0, str(BACKEND_DIR))

        print("==> 导入 CommandRegistry 触发重建…")
        from app.rag.command_registry import command_registry  # noqa: F401

        os.chdir(cwd)

        if not REGISTRY_JSON.exists():
            print("错误：重建后未生成 JSON", file=sys.stderr)
            return 1

        data = json.loads(REGISTRY_JSON.read_text(encoding="utf-8"))
        new_count = data.get("count", 0)
        print(f"==> 重建完成，命令数 = {new_count}")

        if old_count is not None:
            if new_count < old_count:
                print(f"警告：命令数从 {old_count} 下降到 {new_count}，请核对", file=sys.stderr)
            else:
                print(f"    对比旧值 {old_count} -> {new_count}")
        if new_count < args.min_count:
            print(f"警告：命令数 {new_count} 低于阈值 {args.min_count}，请核对", file=sys.stderr)

        print(f"\n==> 请提交 JSON 入库（它是 RAG 的运行时数据源）：")
        print(f"    git add backend/data/command_registry.json")
        return 0

    finally:
        os.chdir(cwd)
        if created_link and expect_link.is_symlink():
            expect_link.unlink()
            print("==> 已清理临时符号链接")


if __name__ == "__main__":
    sys.exit(main())
