import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import i18next from 'i18next';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import { chatText, composerText } from './composerText';
import { restoredEntry } from './sendCommand';
import { describeDroppedQueueMessage } from './serverQueue';
import { extractSessionChecklist } from './taskChecklist';
import { toolMetric } from './toolRowSummary';

/**
 * 纯函数里拼出来的界面文案按当前语言取词(chat 命名空间)。
 *
 * 工具行计量、清单兜底名、排队作废提示这些字串不经组件的 `t`,英文界面下也要是英文;
 * i18next 还没初始化(单测、极早期)时原样返回中文兜底。
 */
const load = (lang: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../i18n/locales/${lang}/chat.json`, import.meta.url)), 'utf8'));

const taskCreate = (id: string): ChatMessage => ({
  type: 'assistant',
  timestamp: '2026-10-07T10:00:00.000Z',
  isToolUse: true,
  toolName: 'TaskCreate',
  toolId: `tool-${id}`,
  toolInput: {},
  toolResult: { content: `Task #${id} created successfully: `, isError: false },
});

describe('i18next 还没初始化', () => {
  it('原样返回中文兜底', () => {
    expect(i18next.isInitialized).toBeFalsy();
    expect(chatText('toolMetric.lines', '3 行', { count: 3 })).toBe('3 行');
    expect(composerText('sendFailed', '发送失败')).toBe('发送失败');
    expect(toolMetric('Read', { file_path: 'a' }, { content: 'x\ny\nz', isError: false })).toEqual({ text: '3 行', isWrite: false });
  });
});

describe('英文界面', () => {
  beforeAll(async () => {
    await i18next.init({
      lng: 'en',
      fallbackLng: false,
      ns: ['chat'],
      defaultNS: 'chat',
      interpolation: { escapeValue: false },
      resources: { en: { chat: load('en') }, 'zh-CN': { chat: load('zh-CN') } },
    });
  });
  afterAll(async () => {
    await i18next.changeLanguage('zh-CN');
  });

  it('工具行计量', () => {
    expect(toolMetric('Read', { file_path: 'a' }, { content: 'x\ny\nz', isError: false }).text).toBe('3 lines');
    expect(toolMetric('Grep', { pattern: 'x' }, { content: '', isError: false, toolUseResult: { numFiles: 6 } }).text).toBe('6 matches');
    expect(toolMetric('Write', { file_path: 'a', content: 'x\ny' }, null).text).toBe('+2 lines');
  });

  it('工具行计量 en 区分单复数(单数形态是 toolMetric.linesAdded_one / lines_one / matches_one)', () => {
    for (const key of ['toolMetric.linesAdded_one', 'toolMetric.lines_one', 'toolMetric.matches_one']) {
      expect(i18next.exists(key, { lng: 'en', ns: 'chat' }), key).toBe(true);
    }
    expect(toolMetric('Read', { file_path: 'a' }, { content: 'x', isError: false }).text).toBe('1 line');
    expect(toolMetric('Grep', { pattern: 'x' }, { content: '', isError: false, toolUseResult: { numFiles: 1 } }).text).toBe('1 match');
    expect(toolMetric('Write', { file_path: 'a', content: 'x' }, null).text).toBe('+1 line');
    expect(toolMetric('Write', { file_path: 'a', content: 'x\ny' }, null).text).toBe('+2 lines');
  });

  it('diff 截断提示 en 区分单复数(单数形态是 details.diffHiddenLines_one)', () => {
    expect(i18next.exists('details.diffHiddenLines_one', { lng: 'en', ns: 'chat' })).toBe(true);
    expect(i18next.t('chat:details.diffHiddenLines', { count: 1 })).toMatch(/^1 more line not shown/);
    expect(i18next.t('chat:details.diffHiddenLines', { count: 7 })).toMatch(/^7 more lines not shown/);
  });

  it('清单里没有标题的任务按编号称呼', () => {
    expect(extractSessionChecklist([taskCreate('7')])?.map((item) => item.content)).toEqual(['Task #7']);
  });

  it('排队作废的提示与恢复不了附图的说明', () => {
    expect(describeDroppedQueueMessage('aborted', '', false)).toBe(
      'The queued message was cancelled along with the stopped turn and was not sent.',
    );
    expect(describeDroppedQueueMessage('expired', '原话', false)).toBe(
      'The queued message waited more than 30 minutes and was discarded without being sent.\n\nOriginal text (copyable) —\n\n> 原话',
    );
    const entry = restoredEntry({ command: {} as never, attachmentsLost: true });
    expect(entry.error).toBe('Images attached to the queued message could not be restored — add them again before sending.');
  });

  it('切回中文时与兜底一致', async () => {
    await i18next.changeLanguage('zh-CN');
    expect(toolMetric('Read', { file_path: 'a' }, { content: 'x\ny\nz', isError: false }).text).toBe('3 行');
    expect(chatText('workPanel.untitledTask', '任务 #7', { id: '7' })).toBe('任务 #7');
  });
});
