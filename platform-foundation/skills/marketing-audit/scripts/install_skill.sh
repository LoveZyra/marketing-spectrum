#!/usr/bin/env bash
# 安装/升级 marketing-audit skill。
#
# R1：解包前断言包内不含 feedback/（防止覆盖账本）
# R3：解包前备份 feedback/，解包后**按行合并**回来再 compact 去重
#     —— 合并而非覆盖，防止备份期间新写入的条目被吃掉。
#     账本是「纯追加 + 读时折叠」设计，所以合并只需 cat + compact，无需冲突消解。
set -euo pipefail

PKG="${1:-}"
SKILL_DIR="${2:-$HOME/.claude/skills/marketing-audit}"
[ -z "$PKG" ] && { echo "用法: $0 <包路径> [skill目录]" >&2; exit 2; }
[ -f "$PKG" ] || { echo "ERROR: 找不到包 $PKG" >&2; exit 2; }

# ── R1 断言 ──
# 注意：这里**不能**写成 `tar tzf ... | grep -q ...`。
# 脚本开了 set -o pipefail，而 grep -q 命中后立刻退出会让 tar 收到 SIGPIPE(141)，
# pipefail 取管道里最后一个非零状态 → 整条管道返回 141 → if 判为假 → 断言被静默跳过。
# 用 here-string 消掉管道，行为才可靠（负向用例实测过：老写法放行了含 feedback/ 的包）。
if grep -qE '(^\./)?feedback/' <<< "$(tar tzf "$PKG")"; then
  echo "ERROR: 安装包内含 feedback/，会覆盖问题账本。" >&2
  echo "       请用 scripts/pack_skill.sh 重新打包（自带 --exclude='feedback'）。" >&2
  exit 1
fi

# ── R3 备份 ──
BK=""
if [ -d "$SKILL_DIR/feedback" ]; then
  BK="$(mktemp -d)"
  cp -a "$SKILL_DIR/feedback/." "$BK/"
  echo "[install] 已备份 feedback/ → $BK"
fi

mkdir -p "$SKILL_DIR"
tar xzf "$PKG" -C "$SKILL_DIR"
echo "[install] 解包完成 → $SKILL_DIR"

# ── R3 合并回来（追加而非覆盖）──
if [ -n "$BK" ]; then
  mkdir -p "$SKILL_DIR/feedback"
  for f in "$BK"/*.jsonl; do
    [ -e "$f" ] || continue
    cat "$f" >> "$SKILL_DIR/feedback/$(basename "$f")"
  done
  ( cd "$SKILL_DIR" && python3 -c "
import sys; sys.path.insert(0, '.')
from snippets.issue_ledger import compact
print('[install] issues.jsonl compact →', compact(), '行')
" ) || echo "[install] compact 跳过（不影响使用）"
  echo "[install] feedback/ 已合并回来，备份保留在 $BK"
fi

echo "[install] DONE"
