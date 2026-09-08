#!/usr/bin/env python3
"""GeoGebra 命令手册 → 结构化 registry（**离线工具**，2026-09-08 从 backend 迁出）。

历史
----
原为 `backend/app/rag/command_registry.py`，运行时被 `/rag/command*` 四个 API 使用。
2026-09-08 起这四个 API 与 `COMMAND_REGISTRY_PATH` 配置一并下线（前端/tests 零调用、
绘图链路 `chat.py` 也从不校验命令），模块迁到本目录，回归"离线解析/查询工具"定位。

用途
----
1. 从手册仓库（默认本仓库 `/srv/geogebra`）的 `zh/commands/<Cmd>/index.html` 解析出
   命令的 syntax / 描述 / 示例，落盘 JSON（供日后若启用 §16.9 命令契约时取用）；
2. 命令行查字典：`--get Circle` / `--search 旋转` / `--list` / `--count`。

用法（在本目录或任意位置运行）：
    python3 command_registry.py                                  # dry-run：只统计
    python3 command_registry.py --apply                          # 落盘 command_registry.json
    python3 command_registry.py --apply --out /tmp/registry.json # 指定输出
    python3 command_registry.py --get Circle                     # 查单个命令（需 JSON 已存在）
    python3 command_registry.py --search 旋转 --limit 5
    python3 command_registry.py --list --limit 10
    python3 command_registry.py --count

注意：
- 手册页面标题形如 `<h1 class="page">Polygon 命令</h1>`；解析失败（无 syntax）的命令会跳过。
- 解析规则与迁出前的业务代码一致（`<dt class="hdlist1">` 取 syntax，`<dd><p>` 取描述）。
- 落盘前自动备份旧 JSON 为 `.bak.<时间戳>`。
"""

import argparse
import json
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

SCRIPT_DIR = Path(__file__).resolve().parent
# 本脚本位于 <手册仓库>/_script/，故手册根目录为其上一级
DEFAULT_MANUAL_DIR = str(SCRIPT_DIR.parent)
DEFAULT_OUT = str(SCRIPT_DIR / "command_registry.json")


class CommandRegistry:
    """解析手册目录构建命令注册表；或加载既有 JSON 做查询。"""

    def __init__(self):
        self.registry: Dict[str, dict] = {}
        self.chinese_index: Dict[str, str] = {}

    # ---------- 解析 ----------

    def _parse_html(self, html_content: str) -> Optional[dict]:
        name_match = re.search(r'<h1 class="page">\s*(\w+)\s*命令\s*</h1>', html_content)
        if not name_match:
            return None
        command_name = name_match.group(1).strip()

        syntax_matches = re.findall(r'<dt class="hdlist1">\s*(.+?)\s*</dt>', html_content, re.DOTALL)
        if not syntax_matches:
            return None

        descriptions = []
        for desc in re.findall(
            r'<dt class="hdlist1">.*?</dt>\s*<dd>\s*<p>(.*?)</p>\s*</dd>', html_content, re.DOTALL
        ):
            desc = re.sub(r"<[^>]+>", "", desc).strip()
            desc = re.sub(r"\s+", " ", desc)
            if desc:
                descriptions.append(desc)

        examples = []
        for example in re.findall(r"<code>(Incircle\([^)]+\)|Circle\([^)]+\))</code>", html_content):
            if example not in examples:
                examples.append(example)

        return {
            "name": command_name,
            "syntax": [s.strip() for s in syntax_matches],
            "descriptions": descriptions,
            "examples": examples,
        }

    def build_from_dir(self, commands_dir: Path) -> int:
        html_files = sorted(commands_dir.glob("**/index.htm*"))
        for html_file in html_files:
            try:
                info = self._parse_html(html_file.read_text(encoding="utf-8"))
            except Exception as e:  # 单页失败不影响整体
                print(f"[warn] 解析失败 {html_file}: {e}")
                continue
            if not info:
                continue
            self.registry[info["name"]] = info
            for desc in info["descriptions"]:
                if "内切圆" in desc:
                    self.chinese_index["内切圆"] = info["name"]
                if "外接圆" in desc:
                    self.chinese_index["外接圆"] = info["name"]
        return len(self.registry)

    # ---------- 查询 ----------

    def load(self, path: Path) -> bool:
        if not path.exists():
            return False
        data = json.loads(path.read_text(encoding="utf-8"))
        self.registry = data.get("commands", {})
        self.chinese_index = data.get("chinese_index", {})
        return True

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            shutil.copy(path, path.with_suffix(path.suffix + f".bak.{int(time.time())}"))
        path.write_text(
            json.dumps(
                {
                    "commands": self.registry,
                    "chinese_index": self.chinese_index,
                    "version": "2.0",
                    "count": len(self.registry),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def get_command(self, name: str) -> Optional[dict]:
        name = name.strip()
        if name in self.registry:
            return self.registry[name]
        if name in self.chinese_index:
            return self.registry.get(self.chinese_index[name])
        for cmd_name, info in self.registry.items():
            if cmd_name.lower() == name.lower():
                return info
        return None

    def search_by_keyword(self, keyword: str) -> List[dict]:
        results, kw = [], keyword.lower()
        for info in self.registry.values():
            if kw in info["name"].lower():
                results.append(info)
                continue
            if any(kw in s.lower() for s in info.get("syntax", [])):
                results.append(info)
                continue
            if any(keyword in d for d in info.get("descriptions", [])):
                results.append(info)
        return results


def resolve_commands_dir(manual_dir: str) -> Path:
    base = Path(manual_dir).expanduser().resolve()
    for candidate in (base / "zh" / "commands", base / "manual" / "zh" / "commands"):
        if candidate.is_dir():
            return candidate
    raise SystemExit(f"错误：{base} 下未找到 zh/commands（用 --manual-dir 指定手册仓库根目录）")


def main() -> int:
    ap = argparse.ArgumentParser(description="GeoGebra 命令手册 registry 离线工具")
    ap.add_argument("--manual-dir", default=DEFAULT_MANUAL_DIR, help=f"手册仓库根目录，默认 {DEFAULT_MANUAL_DIR}")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"输出 JSON 路径，默认 {DEFAULT_OUT}")
    ap.add_argument("--apply", action="store_true", help="真正落盘（默认 dry-run 只统计）")
    ap.add_argument("--get", help="查询单个命令（如 Circle）")
    ap.add_argument("--search", help="关键词搜索")
    ap.add_argument("--list", action="store_true", help="列出命令名")
    ap.add_argument("--count", action="store_true", help="只打印命令总数")
    ap.add_argument("--limit", type=int, default=50, help="--search/--list 返回条数")
    args = ap.parse_args()

    reg = CommandRegistry()

    # 查询模式（不解析手册）
    if args.get or args.search or args.list or args.count:
        if not reg.load(Path(args.out)):
            print(f"[err] JSON 不存在：{args.out}（先跑 --apply 生成）")
            return 1
        if args.count:
            print(len(reg.registry))
        if args.get:
            info = reg.get_command(args.get)
            print(json.dumps(info, ensure_ascii=False, indent=2) if info else f"未找到命令：{args.get}")
        if args.search:
            hits = reg.search_by_keyword(args.search)[: args.limit]
            print(f"命中 {len(hits)} 条：")
            for h in hits:
                print(f"  - {h['name']}: {h['syntax'][0][:80] if h.get('syntax') else ''}")
        if args.list:
            for name in list(reg.registry)[: args.limit]:
                print(name)
        return 0

    # 构建模式
    commands_dir = resolve_commands_dir(args.manual_dir)
    n = reg.build_from_dir(commands_dir)
    print(f"[info] 手册目录：{commands_dir}")
    print(f"[info] 解析到命令：{n} 条")
    if not args.apply:
        print("[dry-run] 未落盘；加 --apply 写入")
        return 0
    reg.save(Path(args.out))
    print(f"[done] 已写入：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
