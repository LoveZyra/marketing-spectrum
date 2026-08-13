#!/usr/bin/env bash
# 打包 marketing-audit skill。
#
# R1（评估文档 §4.1）：feedback/ 是跨版本持久数据，**绝不能进安装包**，
# 否则 `tar xzf -C` 会把线上账本覆盖回打包时的快照。
# 本脚本既排除，也在打包后自检，双保险。
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-}"
OUTDIR="${2:-${SKILL_DIR}/..}"          # 可选：输出目录，默认放 skill 同级
[ -z "$VERSION" ] && { echo "用法: $0 <version> [输出目录]   例: $0 fix23" >&2; exit 2; }
mkdir -p "$OUTDIR"
PKG="$(cd "$OUTDIR" && pwd)/ma-skill-${VERSION}.tar.gz"

cd "$SKILL_DIR"
tar czf "$PKG" \
    --exclude='feedback' \
    --exclude='dist' \
    --exclude='__pycache__' \
    --exclude='*.pyc' \
    --exclude='.git' \
    --exclude='*.tar.gz' \
    --exclude='营销诊断介绍.html' \
    --exclude='*.md.bak' \
    --exclude='patch_*.py' \
    --exclude='demo_*.py' \
    --exclude='*.bak' \
    .

# 自检：包内绝不允许出现 feedback/
# 同 install_skill.sh：用 here-string 而非管道 —— pipefail + grep -q 提前退出会让
# tar 收到 SIGPIPE，管道返回 141，if 判为假，断言形同虚设。
if grep -qE '(^\./)?feedback/' <<< "$(tar tzf "$PKG")"; then
  echo "ERROR: 安装包内含 feedback/，会覆盖线上问题账本。已删除该包。" >&2
  rm -f "$PKG"
  exit 1
fi

# 自检 2：13MB 的介绍页只是仓库里的说明材料，线上不需要，进包纯属浪费带宽与磁盘
if grep -qE '营销诊断介绍\.html' <<< "$(tar tzf "$PKG")"; then
  echo "ERROR: 安装包内含 营销诊断介绍.html（13MB 说明材料，线上不需要）。已删除该包。" >&2
  rm -f "$PKG"
  exit 1
fi

echo "OK  $PKG"
echo "    大小: $(du -h "$PKG" | cut -f1)  条目: $(tar tzf "$PKG" | wc -l)"
echo "    md5: $(md5sum "$PKG" 2>/dev/null | cut -d' ' -f1 || md5 -q "$PKG")"
echo "    已确认不含 feedback/"
