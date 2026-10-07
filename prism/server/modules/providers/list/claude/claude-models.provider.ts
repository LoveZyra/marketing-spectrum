import { open, readFile, stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readProviderSessionActiveModelChange,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

import { claudeModelCatalog } from './claude-model-catalog.service.js';

// 别名表定义在 claude-model-aliases.ts(模型目录服务也要它,放这里会成环),这里转导出给 claude-sdk.js 用。
export { CLAUDE_FALLBACK_MODELS } from './claude-model-aliases.js';

type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel || null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    if (changedModel?.[1]?.trim()) {
      return changedModel[1].trim();
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag || null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

/** 从一段文本里从后往前找第一条带 model 的事件。 */
const scanModelFromEnd = (
  content: string,
  sessionId: string,
): ProviderCurrentActiveModel | null => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

const MODEL_TAIL_BYTES = 64 * 1024;

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  // 先只读尾部 64KB(与 synchronizer 的尾读同法):当前模型来自最近的 assistant/
  // init 事件,几乎总在尾部,不必把几十 MB 的 transcript 整个读进来。尾部第一行
  // 可能被截断,`scanModelFromEnd` 的 JSON.parse 会跳过坏行。
  try {
    const { size } = await stat(jsonlPath);
    if (size > MODEL_TAIL_BYTES) {
      const handle = await open(jsonlPath, 'r');
      try {
        const start = size - MODEL_TAIL_BYTES;
        const buffer = Buffer.alloc(MODEL_TAIL_BYTES);
        await handle.read(buffer, 0, MODEL_TAIL_BYTES, start);
        const tailHit = scanModelFromEnd(buffer.toString('utf8'), sessionId);
        if (tailHit) return tailHit;
      } finally {
        await handle.close();
      }
      // 尾部没找到(罕见:尾段全是 user 消息、无 model 事件)→ 回落整读。
    }
  } catch {
    // stat/尾读失败 → 回落整读。
  }

  const content = await readFile(jsonlPath, 'utf8');
  return scanModelFromEnd(content, sessionId);
};

export class ClaudeProviderModels implements IProviderModels {
  /**
   * 全量:上架的目录条目 + 别名组(`group: 'alias'`),不按人过滤。
   *
   * claude 在 `UNCACHED_PROVIDERS` 里,同一时刻的并发请求共用一个在途 promise(按 provider 去重),
   * 接口本身也不带用户;按人过滤的定义由 claude-gateways.service 的 modelsDefinitionFor 给出。
   * CLI 的 `supportedModels()` 不用:它只认 claude-*,而且每次会留一个幽灵会话。
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return claudeModelCatalog.buildModelsDefinition();
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    // A model picked through /models applies on the NEXT turn, so it is not in
    // the transcript yet. Report it anyway: answering with the previous model
    // immediately after someone switched reads as "the switch did nothing".
    try {
      const pending = await readProviderSessionActiveModelChange('claude', sessionId);
      if (pending.changed && pending.model?.trim()) {
        return { model: pending.model.trim(), source: 'pending' };
      }
    } catch {
      // Fall through to reading the transcript below.
    }

    try {
      const session = sessionsDb.getSessionById(sessionId);
      const jsonlPath = session?.jsonl_path;
      // Every event in the transcript carries Claude's own session id, never the
      // app-side id Prism allocates before the run starts; reading with the app id
      // would make the per-event guard in extractClaudeEventModel reject every line.
      // Fall back to the given id for sessions discovered on disk, where both ids match.
      const transcriptSessionId = session?.provider_session_id?.trim() || sessionId;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(transcriptSessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return { ...activeModel, source: 'transcript' };
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('claude', input);
  }
}
