#!/usr/bin/env bash
# Upload an HTML (or any) file to Prism's public dir and print its public URL.
# Usage: upload.sh <src> [english-name]
#   <english-name>: a readable English name for the file (the agent translates
#   Chinese/etc. names to English first). It is sanitized to an ASCII kebab-case
#   slug, prefixed with an 8-hex id, and given the source file's extension, so the
#   public URL is meaningful and never percent-encoded.
#   e.g. upload.sh <path> "marketing-diagnosis-skill-report-offline-v2"
#        -> https://.../<id>_marketing-diagnosis-skill-report-offline-v2.html
# Served by Prism (port 8080) via express.static at the URL ROOT, fronted by the
# Friday gateway. /home/jovyan/prism/public/ is the proven-working serving dir
# (the /html-files/ route is NOT mounted on this pod — returns 404).
# If <english-name> is omitted: an already-ASCII source name is kept verbatim;
# a non-ASCII name is auto-slugified (strips non-ASCII; pure-CJK -> "<id>.html").
set -euo pipefail

UPLOAD_DIR="/home/jovyan/prism/public"
BASE_URL="https://friday_deployment_14540_algo_agent.gw.friday.17usoft.com"

if [ $# -lt 1 ]; then
  echo "用法: upload-html <文件路径> [英文名]" >&2
  exit 1
fi

SRC="$1"
REQUESTED="${2:-}"

if [ ! -f "$SRC" ]; then
  echo "错误: 文件不存在: $SRC" >&2
  exit 1
fi

mkdir -p "$UPLOAD_DIR"

DEST_FILE="$(python3 - "$SRC" "$REQUESTED" <<'PY'
import os, re, sys, secrets
src = sys.argv[1]
requested = sys.argv[2] if len(sys.argv) > 2 else ""

# Preserve compound extensions like .tar.gz (splitext alone would only catch .gz).
lower = src.lower()
ext = os.path.splitext(src)[1].lower()
for compound in ('.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.lz'):
    if lower.endswith(compound):
        ext = compound
        break

def slugify(s):
    return re.sub(r'[^a-zA-Z0-9]+', '-', re.sub(r'[^\x00-\x7F]', '', s)).strip('-').lower()

if requested:
    slug = slugify(requested)
    out = f"{secrets.token_hex(4)}{('_'+slug) if slug else ''}{ext}"
else:
    name = os.path.basename(src)
    if all(ord(c) < 128 for c in name):
        out = name  # already ASCII (Prism-staged) -> keep verbatim
    else:
        # Drop the staging file's leading 8-hex prefix before slugifying, so the
        # fallback name isn't double-prefixed (e.g. 271d6197_营销... -> 'skill',
        # not '271d6197-skill'). The non-ASCII is then stripped; pure-CJK -> '<id>'.
        base = re.sub(r'^[0-9a-f]{8}_', '', os.path.splitext(name)[0])
        slug = slugify(base)
        out = f"{secrets.token_hex(4)}{('_'+slug) if slug else ''}{ext}"
        # Nudge (stderr — doesn't pollute the URL on stdout) so the agent/user
        # knows to pass an English name next time for a meaningful, readable URL.
        sys.stderr.write("提示：文件名含非英文且未提供英文名，已用 ASCII slug；带英文名重发可获可读 URL：upload.sh <路径> <英文名>\n")
print(out)
PY
)"

DEST="$UPLOAD_DIR/$DEST_FILE"
# If a file with this name already exists, prepend an 8-hex prefix to avoid overwriting.
if [ -f "$DEST" ]; then
  DEST_FILE="$(python3 -c 'import secrets; print(secrets.token_hex(4))')_${DEST_FILE}"
  DEST="$UPLOAD_DIR/$DEST_FILE"
fi

cp "$SRC" "$DEST"

echo "${BASE_URL}/${DEST_FILE}"
