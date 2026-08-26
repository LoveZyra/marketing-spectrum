import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { sessionsDb } from '@/modules/database/index.js';
import { ClaudeProviderModels } from '@/modules/providers/list/claude/claude-models.provider.js';
import { getProviderSessionActiveModelChangesPath, writeProviderSessionActiveModelChange } from '@/shared/utils.js';

/**
 * `/models` reports the session's current model. Getting it wrong is not
 * cosmetic: it is the only feedback the user has that a switch landed, and the
 * model picker on the new-chat screen was removed in favour of this command.
 */
const APP_SESSION_ID = 'prism-allocated-app-session-id';
const PROVIDER_SESSION_ID = 'claude-native-session-id';

const originalGetSessionById = sessionsDb.getSessionById;
let tempDirectory: string | null = null;
let previousDataDir: string | undefined;

afterEach(async () => {
  sessionsDb.getSessionById = originalGetSessionById;
  if (previousDataDir === undefined) {
    delete process.env.PRISM_DATA_DIR;
  } else {
    process.env.PRISM_DATA_DIR = previousDataDir;
  }
  if (tempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true });
    tempDirectory = null;
  }
});

/**
 * A realistic Claude transcript: every event carries Claude's own session id,
 * never the app-side id Prism allocated before the run started.
 */
async function withSession(options: { providerSessionId: string | null }) {
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-active-model-'));
  previousDataDir = process.env.PRISM_DATA_DIR;
  process.env.PRISM_DATA_DIR = tempDirectory;

  const jsonlPath = path.join(tempDirectory, 'transcript.jsonl');
  await writeFile(
    jsonlPath,
    `${[
      JSON.stringify({ type: 'system', subtype: 'init', session_id: PROVIDER_SESSION_ID, model: 'claude-opus-4-1' }),
      JSON.stringify({ type: 'assistant', session_id: PROVIDER_SESSION_ID, message: { model: 'claude-opus-4-1', content: [] } }),
    ].join('\n')}\n`,
    'utf8',
  );

  sessionsDb.getSessionById = ((id: string) => (id === APP_SESSION_ID
    ? { jsonl_path: jsonlPath, provider_session_id: options.providerSessionId }
    : null)) as typeof sessionsDb.getSessionById;

  return jsonlPath;
}

describe('/models 报告的当前模型', () => {
  test('在 Prism 里新建的会话:用 app id 传进来,也要读得出真实模型', async () => {
    await withSession({ providerSessionId: PROVIDER_SESSION_ID });

    const active = await new ClaudeProviderModels().getCurrentActiveModel(APP_SESSION_ID);

    // 曾经这里返回 'default':对话记录里每条事件带的都是 Claude 自己的
    // session id,拿 app id 去比一律不匹配,于是整份记录都被跳过。
    assert.equal(active.model, 'claude-opus-4-1');
  });

  test('磁盘扫出来的老会话没有 provider id,回退用传进来的那个', async () => {
    await withSession({ providerSessionId: null });

    // 这类会话两个 id 本来就是同一个,所以拿 app id 直接读也读得到 ——
    // 正是这一点让当初的 bug 看起来时灵时不灵。
    sessionsDb.getSessionById = ((id: string) => (id === PROVIDER_SESSION_ID
      ? { jsonl_path: path.join(tempDirectory!, 'transcript.jsonl'), provider_session_id: null }
      : null)) as typeof sessionsDb.getSessionById;

    const active = await new ClaudeProviderModels().getCurrentActiveModel(PROVIDER_SESSION_ID);
    assert.equal(active.model, 'claude-opus-4-1');
  });

  test('刚切完还没发下一轮:报告将要生效的那个模型,而不是记录里的旧模型', async () => {
    await withSession({ providerSessionId: PROVIDER_SESSION_ID });
    await writeProviderSessionActiveModelChange(
      'claude',
      { sessionId: APP_SESSION_ID, model: 'haiku' },
      { filePath: getProviderSessionActiveModelChangesPath() },
    );

    const active = await new ClaudeProviderModels().getCurrentActiveModel(APP_SESSION_ID);

    // 记录里还写着 opus,但下一轮会用 haiku。报 opus 会让人以为没切成功。
    assert.equal(active.model, 'haiku');
  });

  test('没有会话 id 时回落到供应商默认值,不抛异常', async () => {
    const active = await new ClaudeProviderModels().getCurrentActiveModel('');
    assert.equal(active.model, 'default');
  });

  // bx / E4:超过 64KB 的大 transcript 走尾读,不整读也要读出最新模型。
  test('大 transcript(>64KB)只读尾部也能读出最近模型', async () => {
    tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-active-model-big-'));
    previousDataDir = process.env.PRISM_DATA_DIR;
    process.env.PRISM_DATA_DIR = tempDirectory;
    const jsonlPath = path.join(tempDirectory, 'big.jsonl');

    // 头部一条旧模型,中间灌 ~200KB 的用户/助手消息,末尾一条新模型的 assistant。
    const lines: string[] = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: PROVIDER_SESSION_ID, model: 'claude-opus-4-1' }),
    ];
    const filler = 'x'.repeat(400);
    for (let i = 0; i < 500; i += 1) {
      lines.push(JSON.stringify({ type: 'user', session_id: PROVIDER_SESSION_ID, message: { role: 'user', content: `${filler}${i}` } }));
    }
    lines.push(JSON.stringify({ type: 'assistant', session_id: PROVIDER_SESSION_ID, message: { model: 'claude-sonnet-4-5', content: [] } }));
    await writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');

    sessionsDb.getSessionById = ((id: string) => (id === APP_SESSION_ID
      ? { jsonl_path: jsonlPath, provider_session_id: PROVIDER_SESSION_ID }
      : null)) as typeof sessionsDb.getSessionById;

    const active = await new ClaudeProviderModels().getCurrentActiveModel(APP_SESSION_ID);
    // 末尾那条 assistant 的模型,尾读必须命中(不是头部的 opus)。
    assert.equal(active.model, 'claude-sonnet-4-5');
  });
});
