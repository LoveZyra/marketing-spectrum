#!/usr/bin/env python3
"""End-to-end demo: inject one defect per gate, show the pyramid stop it.

    python3 examples/demo.py

Everything below runs with ZERO LLM calls. That is the point.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet.contract import load_contract  # noqa: E402
from skillwhet.gates import (  # noqa: E402
    build_fast_pyramid, format_report, run_pyramid,
)

EXAMPLE = ROOT / "examples" / "pdf-tables"

CLEAN = (EXAMPLE / "scripts" / "extract.py").read_text(encoding="utf-8")

CASES: list[tuple[str, str, str]] = [
    (
        "G0  truncated output",
        "LLM 生成被截断在函数中间——最常见的代码生成失败",
        "def extract_tables(path: str) -> list:\n    rows = []\n    for line in",
    ),
    (
        "G1  import outside allowlist",
        "偷偷引入 CONTRACT 未声明的第三方依赖",
        "import requests\n\n\ndef extract_tables(path: str, pages: str | None = None) -> list:\n"
        "    return requests.get(path).json()\n\n\ndef normalize_cell(raw: str) -> str:\n    return raw\n",
    ),
    (
        "G1  undeclared side effect",
        "CONTRACT 声明 side_effects=[none]，代码却写文件",
        "def extract_tables(path: str, pages: str | None = None) -> list:\n"
        "    with open('/tmp/cache.txt', 'w') as fh:\n        fh.write('x')\n    return []\n\n\n"
        "def normalize_cell(raw: str) -> str:\n    return raw\n",
    ),
    (
        "G2  defensive-code bloat",
        "P3 能力驱动路径最典型的病态产物：裸 except + 静默吞错",
        "import re\n\n\ndef extract_tables(path: str, pages: str | None = None) -> list:\n"
        "    try:\n        return []\n    except:\n        pass\n    return []\n\n\n"
        "def normalize_cell(raw: str) -> str:\n    return re.sub(r'\\s+', ' ', raw).strip()\n",
    ),
    (
        "G3  signature drift",
        "代码加了参数，文档与契约还停在旧签名——端到端能测出分数掉，但定位不到该改哪边",
        "import re\n\n\ndef extract_tables(path: str, pages: str | None = None, strict: bool = False) -> list:\n"
        "    return []\n\n\ndef normalize_cell(raw: str) -> str:\n"
        "    return re.sub(r'\\s+', ' ', raw).strip()\n",
    ),
    (
        "G5  reward hacking",
        "背下可见测试的输入直接返回答案——G4 全绿，只有留出测试能抓住",
        "import re\n\n\ndef extract_tables(path: str, pages: str | None = None) -> list[list[list[str]]]:\n"
        "    with open(path, encoding='utf-8') as fh:\n        text = fh.read()\n"
        "    if text == 'a|b\\nc|d\\n\\ne|f\\n':\n"
        "        return [[['a', 'b'], ['c', 'd']], [['e', 'f']]]\n"
        "    raise ValueError('unsupported document')\n\n\n"
        "def normalize_cell(raw: str) -> str:\n"
        "    return re.sub(r'\\s+', ' ', raw).strip().lstrip('$').strip()\n",
    ),
]


def run(tmp: Path, source: str, *, title: str, note: str) -> None:
    skill = tmp / "skill"
    if skill.exists():
        shutil.rmtree(skill)
    shutil.copytree(EXAMPLE, skill,
                    ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    (skill / "scripts" / "extract.py").write_text(source, encoding="utf-8")

    print(f"\n\033[1m{title}\033[0m")
    print(f"  {note}")
    res = run_pyramid(skill, load_contract(skill), build_fast_pyramid())
    print(format_report(res))


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        print("=" * 78)
        print("  基线：未改动的 skill")
        print("=" * 78)
        run(tmp, CLEAN, title="clean", note="六道门全过，零 LLM 调用")

        print("\n" + "=" * 78)
        print("  逐门注入缺陷")
        print("=" * 78)
        for title, note, src in CASES:
            run(tmp, src, title=title, note=note)

    print("\n" + "=" * 78)
    print("  每一道门都真的拦得住它存在的理由。全程 0 次模型调用。")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
