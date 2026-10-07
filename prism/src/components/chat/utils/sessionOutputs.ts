import type { ChatMessage } from '../types/types';

/**
 * 会话产出文件:从消息流里扫 Write 工具调用,聚成右侧面板的「产出文件」表。
 *
 * 用消息而不用 checkpoint 的改动清单,是因为消息就是落了盘的显示日志 ——
 * 刷新、换端回来列表照在,且天然跨回合累计;checkpoint 那份只有最近一轮,
 * 卡片一关就没了。Bash 等方式写盘的文件不是 Write 调用,靠 changed_files 帧
 * 转成的伪 Write 计入(见 workFrames.ts 的 changedFilesToMessages)。
 */

/**
 * 噪声排除表:本会话新建的文件都算产出,只排明显的中间产物 / 噪声。
 *
 * 不用"可交付扩展名白名单":agent 交付的常常就是脚本(gen_users.py、wordcount.sh…),
 * 白名单会把它们漏掉,面板与正文里列出的产出就对不上。
 */
const EXCLUDED_EXTENSIONS = new Set(['tmp', 'log', 'lock', 'cache', 'pyc', 'swp', 'part']);
const EXCLUDED_PATH_SEGMENTS = ['/node_modules/', '/.git/', '/__pycache__/', '/.venv/', '/dist/'];

export interface SessionOutputFile {
  /** Write 时的原始路径(通常是绝对路径),打开/下载都用它。 */
  path: string;
  /** 文件名(basename),列表展示用。 */
  name: string;
}

function extractWritePath(raw: unknown): string | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const filePath = (value as { file_path?: unknown } | null | undefined)?.file_path;
  return typeof filePath === 'string' && filePath.trim() ? filePath.trim() : null;
}

export function isDeliverablePath(path: string): boolean {
  const normalized = `/${path.replace(/\\/g, '/')}`;
  if (EXCLUDED_PATH_SEGMENTS.some((segment) => normalized.includes(segment))) return false;
  const base = normalized.split('/').pop() || '';
  if (!base || base.startsWith('.')) return false; // 隐藏文件(.env/.gitignore…)不当产出
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex > 0) {
    const extension = base.slice(dotIndex + 1).toLowerCase();
    if (EXCLUDED_EXTENSIONS.has(extension)) return false;
  }
  return true;
}

/**
 * 产出表是会话级只增不减的(按路径去重,只在文件被回滚时才减)。跨回合累计是这张表的
 * 用途本身(用户要能翻到几天前那个文件),所以不按时间过期,只加硬上限兜底:超了丢最早的,
 * 保留最近 MAX 条。真正的载荷上限在服务端(见 sessions.service.ts 的 MAX_WORK_FRAMES),
 * 这里是前端侧的第二道闸。
 */
export const MAX_SESSION_OUTPUTS = 300;

/**
 * 时间正序扫全量消息:每个 Write 出的可交付文件记一条,按首次出现排序,
 * 重写同一路径不重复(重放同一段消息幂等 —— 调用方可拼接"服务端基线 +
 * 已加载窗口",重叠无害)。子代理 childTools 里的 Write 同样计入。
 *
 * 只认已成功执行的 Write(toolResult 落地且非错):审批还挂着/被拒绝/
 * 失败的写入,文件根本不在盘上,列出来点「打开/下载」就是 404。
 * 运行中的写入等结果帧落地、消息重转后自然入列。
 */
export function extractSessionOutputs(messages: readonly ChatMessage[]): SessionOutputFile[] {
  const seen = new Set<string>();
  const outputs: SessionOutputFile[] = [];
  const applyWrite = (toolName: unknown, toolInput: unknown, result: { isError?: unknown } | null | undefined) => {
    if (toolName !== 'Write') return;
    if (!result || result.isError) return;
    const path = extractWritePath(toolInput);
    if (!path || seen.has(path) || !isDeliverablePath(path)) return;
    seen.add(path);
    outputs.push({ path, name: path.split(/[\\/]/).pop() || path });
  };

  for (const message of messages) {
    if (message?.isToolUse) {
      applyWrite(message.toolName, message.toolInput, message.toolResult);
    }
    const children = message?.subagentState?.childTools;
    if (Array.isArray(children)) {
      for (const child of children) applyWrite(child?.toolName, child?.toolInput, child?.toolResult);
    }
  }
  return outputs.length > MAX_SESSION_OUTPUTS ? outputs.slice(-MAX_SESSION_OUTPUTS) : outputs;
}

/**
 * 产出表默认只露最近的这些条,更早的折起来。
 *
 * 表按首次出现正序排,刚写出来的在最下面;不折的话文件一多就得滚到底才看得见,
 * 而列高只有半栏。
 *
 * 折叠规则和任务清单那边刻意不同:文件没有"完成"这一说,判据只能是新旧 ——
 * 留最近的,把更早的收进一行可点开的摘要里。顺序不动(仍与时间轴一致,
 * 最新的在最下面、贴着输入框),这样"刚产出的文件"一眼就在。
 */
export const OUTPUT_FOLD_THRESHOLD = 10;

export interface FoldedOutputs {
  /** 要渲染的条目(折起来时是最近 OUTPUT_FOLD_THRESHOLD 条)。 */
  visible: SessionOutputFile[];
  /** 被折起来的条数;0 表示没有可折的,不必显示那一行。 */
  hidden: number;
}

/** 纯函数:按"留最近的"折叠产出表。展开时原样返回,hidden 仍报实际条数。 */
export function foldEarlierOutputs(
  files: readonly SessionOutputFile[],
  expanded: boolean,
): FoldedOutputs {
  const hidden = Math.max(0, files.length - OUTPUT_FOLD_THRESHOLD);
  if (hidden === 0 || expanded) return { visible: [...files], hidden };
  return { visible: files.slice(-OUTPUT_FOLD_THRESHOLD), hidden };
}
