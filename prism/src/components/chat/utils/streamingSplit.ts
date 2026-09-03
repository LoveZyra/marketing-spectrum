/**
 * 流式正文的「封版前缀 / 活动尾巴」切分(dl)。
 *
 * 问题:打字机每 ~100ms 一次 flush,每次都把**全量**累积文本重新过一遍
 * markdown 解析 —— 单帧成本随答案长度线性涨,整轮是二次方。长答案的后半段,
 * 打字机肉眼可见地变卡。
 *
 * 做法:在最后一个**安全段落边界**把文本切成两半 ——
 * 前缀(stable)已经封版,内容只增不改,memo 住,只在又一个段落完成时才重解析;
 * 尾巴(tail)是正在打的那一段,每次 flush 只解析它自己(几百字符)。
 *
 * 「安全边界」= 不在未闭合代码栅栏(``` / ~~~)里的空行。段落、列表、表格、
 * 引用在空行处都已经自闭合;代码栅栏是唯一跨空行的块,所以栅栏开着时一律不切。
 * 找不到任何安全边界(整段都在一个栅栏里)就整段当尾巴 —— 行为退回现状,不会更糟。
 */

export interface StreamingSplit {
  stable: string;
  tail: string;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * @param text 全量累积文本
 * @param minTail 尾巴至少保留这么多字符再切 —— 边界刚好贴着末尾时不值得
 *   为几个字符多养一个解析实例。
 */
export function splitStreamingMarkdown(text: string, minTail = 24): StreamingSplit {
  if (!text) return { stable: '', tail: '' };

  let fenceMarker: string | null = null; // 开着的栅栏字符('`' 或 '~')与长度
  let fenceLen = 0;
  let boundary = 0; // stable 的结束偏移(含边界空行本身)

  let lineStart = 0;
  const length = text.length;
  while (lineStart <= length) {
    let lineEnd = text.indexOf('\n', lineStart);
    const hasNewline = lineEnd !== -1;
    if (!hasNewline) lineEnd = length;
    const line = text.slice(lineStart, lineEnd);

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const markerLen = fenceMatch[1].length;
      if (fenceMarker === null) {
        fenceMarker = marker;
        fenceLen = markerLen;
      } else if (marker === fenceMarker && markerLen >= fenceLen) {
        // 闭合栅栏:同字符、长度不短于开栅栏,且行内除栅栏外只有空白
        if (line.slice(fenceMatch[0].length).trim() === '') {
          fenceMarker = null;
          fenceLen = 0;
        }
      }
    } else if (fenceMarker === null && line.trim() === '' && hasNewline) {
      // 栅栏闭合状态下的空行 = 安全边界。边界含这一整行(连同换行)。
      boundary = lineEnd + 1;
    }

    if (!hasNewline) break;
    lineStart = lineEnd + 1;
  }

  if (boundary === 0 || length - boundary < minTail) {
    return { stable: '', tail: text };
  }
  return { stable: text.slice(0, boundary), tail: text.slice(boundary) };
}
