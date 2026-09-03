import type { ChatMessage } from '../types/types';

import { isDeliverablePath } from './sessionOutputs';
import { toolMetric } from './toolRowSummary';

export interface TurnOutputFile {
  /** Write 时的原始路径(通常是绝对路径),打开预览用它。 */
  path: string;
  /** 卡片上显示的名字:项目内相对路径优先,拿不到就用文件名。 */
  display: string;
  /** 写入量,如 `+412 行`;算不出来时为空串。 */
  metric: string;
}

/** 绝对路径 → 项目内相对路径(拿不到项目根就退回文件名)。 */
export function displayOutputPath(path: string, projectPath?: string | null): string {
  const normalized = path.replace(/\\/g, '/');
  const root = projectPath ? projectPath.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (root && normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized.split('/').pop() || normalized;
}

/**
 * ef:**这一轮**写出来的可交付文件(设计稿里回答下方那张「产出」卡)。
 *
 * 与 `extractSessionOutputs`(会话级累计,右侧面板用)同源同判据 —— 成功执行的
 * Write、排掉噪声路径、按路径去重 —— 只是范围收到一个工具组内,并且多带一个
 * 写入量:那一轮到底产出了多大的东西,是读完结论后最先想知道的事。
 */
export function extractTurnOutputs(
  messages: readonly ChatMessage[],
  projectPath?: string | null,
): TurnOutputFile[] {
  const seen = new Set<string>();
  const outputs: TurnOutputFile[] = [];

  const applyWrite = (
    toolName: unknown,
    toolInput: unknown,
    result: { isError?: unknown } | null | undefined,
  ) => {
    if (toolName !== 'Write') return;
    if (!result || result.isError) return;
    let value: unknown = toolInput;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        return;
      }
    }
    const raw = (value as { file_path?: unknown } | null | undefined)?.file_path;
    const path = typeof raw === 'string' ? raw.trim() : '';
    if (!path || seen.has(path) || !isDeliverablePath(path)) return;
    seen.add(path);
    const metric = toolMetric('Write', toolInput, (result ?? null) as ChatMessage['toolResult']);
    // 新建文件的 `+N −0` 在这里只说一半的话:卡片上要的是"写了多少",
    // 删除量是编辑才有的概念,所以只取增量那一半。
    const added = /\+(\d+)/.exec(metric.text)?.[1];
    outputs.push({
      path,
      display: displayOutputPath(path, projectPath),
      metric: added ? `+${added} 行` : '',
    });
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

  return outputs;
}

/**
 * 按工具组缓存一次抽取结果。
 *
 * `stabilizeGroupIdentity` 保证内容没变的组在多轮渲染里是**同一个对象**,所以用
 * WeakMap 挂在组上最省事:流式期间每 100ms 一次的重渲不会把每一段都重扫一遍
 * (长会话里这类全量扫描是 tick 开销的大头)。项目根变了就重算。
 */
const TURN_OUTPUT_CACHE = new WeakMap<object, { projectPath: string; outputs: TurnOutputFile[] }>();

export function extractTurnOutputsCached(
  group: object,
  messages: readonly ChatMessage[],
  projectPath?: string | null,
): TurnOutputFile[] {
  const key = projectPath ?? '';
  const hit = TURN_OUTPUT_CACHE.get(group);
  if (hit && hit.projectPath === key) return hit.outputs;
  const outputs = extractTurnOutputs(messages, projectPath);
  TURN_OUTPUT_CACHE.set(group, { projectPath: key, outputs });
  return outputs;
}

/** 服务端 work-frames 响应里的一条产出(见 sessions.service.ts 的 TurnOutputFile)。 */
export interface ServerTurnOutputFile {
  path: string;
  addedLines: number | null;
}

/**
 * ej:把服务端算好的「回合 → 产出」映射转成卡片要的形状。
 *
 * 服务端只给**路径 + 行数**(它不知道项目根,也不该管展示),显示名与噪声过滤
 * 仍在前端做,判据与窗口内抽取(`extractTurnOutputs`)、右侧产出表
 * (`extractSessionOutputs`)完全同源 —— 三处显示同一批文件,规则只有一份。
 */
export function turnOutputsFromServer(
  raw: unknown,
  projectPath?: string | null,
): Map<string, TurnOutputFile[]> {
  const result = new Map<string, TurnOutputFile[]>();
  if (!raw || typeof raw !== 'object') return result;
  for (const [messageId, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!messageId || !Array.isArray(entries)) continue;
    const files: TurnOutputFile[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const record = entry as { path?: unknown; addedLines?: unknown } | null | undefined;
      const path = typeof record?.path === 'string' ? record.path.trim() : '';
      if (!path || seen.has(path) || !isDeliverablePath(path)) continue;
      seen.add(path);
      const added = typeof record?.addedLines === 'number' && Number.isFinite(record.addedLines)
        ? Math.max(0, Math.trunc(record.addedLines))
        : null;
      files.push({
        path,
        display: displayOutputPath(path, projectPath),
        metric: added !== null ? `+${added} 行` : '',
      });
    }
    if (files.length > 0) result.set(messageId, files);
  }
  return result;
}
