import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  carryDraftKey, isSessionGoneProtocolError, removedInfoFromFrame, removedInfoFromNotFound,
  takeQueuedTextForRemoval,
} from './sessionRemoved';
import { draftStorageKey } from './composerDrafts';

/**
 * gk:「这条会话已被删除」态。
 *
 * 2026-09-14 生产截图:一句给开发者看的英文 `Session "…" was not found. Create it via
 * POST /api/providers/sessions first.` 出现两次,中间夹着用户那句话,还有一个只会再撞
 * 一次的「重发上一条消息」。这里钉三根线:只对 chat.send 的 SESSION_NOT_FOUND 切态、
 * 帧 → 信息的转换、以及「新建会话继续」带草稿用的键与新建会话页读的是同一个。
 */
describe('isSessionGoneProtocolError', () => {
  it('只认 chat.send 上的 SESSION_NOT_FOUND', () => {
    expect(isSessionGoneProtocolError({ code: 'SESSION_NOT_FOUND', request: 'chat.send' })).toBe(true);
  });

  it('permission-response 上的同名 code(没这条待批)不算;别的 code 也不算;老服务端不带 request 也不算', () => {
    expect(isSessionGoneProtocolError({ code: 'SESSION_NOT_FOUND', request: 'permission-response' })).toBe(false);
    expect(isSessionGoneProtocolError({ code: 'SESSION_NOT_FOUND' })).toBe(false);
    expect(isSessionGoneProtocolError({ code: 'QUEUE_FULL', request: 'chat.send' })).toBe(false);
  });
});

describe('removedInfoFromFrame', () => {
  it('把 session_removed 帧翻成信息:谁删的、叫什么、能不能恢复', () => {
    const info = removedInfoFromFrame({ reason: 'deleted', deletedBy: 'wjx', sessionName: '胡萍', restorable: true, timestamp: '2026-09-14T14:31:07.000Z' });
    expect(info).toEqual({
      reason: 'deleted', deletedBy: 'wjx', sessionName: '胡萍', restorable: true,
      at: '2026-09-14T14:31:07.000Z', queuedText: null,
    });
  });

  it('删项目带走的标成 project_deleted;缺字段回退成 null / 可恢复', () => {
    const info = removedInfoFromFrame({ reason: 'project_deleted' });
    expect(info.reason).toBe('project_deleted');
    expect(info.deletedBy).toBeNull();
    expect(info.restorable).toBe(true);
    expect(removedInfoFromFrame({ reason: 'deleted', restorable: false }).restorable).toBe(false);
  });

  it('发送时才发现不在了:reason=not_found', () => {
    expect(removedInfoFromNotFound().reason).toBe('not_found');
  });

  it('切态时把排队卡上那条正文带出来(空白当没有)', () => {
    expect(removedInfoFromFrame({ reason: 'deleted' }, '  还没发出去的那句  ').queuedText).toBe('  还没发出去的那句  ');
    expect(removedInfoFromFrame({ reason: 'deleted' }, '   ').queuedText).toBeNull();
    expect(removedInfoFromNotFound('排队那句').queuedText).toBe('排队那句');
  });
});

/**
 * 切「已被删除」态会把排队记录清掉(否则后台续发会一直给一条不存在的会话起新轮),
 * 而那句话是用户亲手打的 —— 先取出来再清,交给说明卡与「新建会话继续」。
 */
describe('takeQueuedTextForRemoval', () => {
  it('取出正文并清掉盘上那条', () => {
    const cleared: string[] = [];
    const text = takeQueuedTextForRemoval('s1', () => ({ content: '把报告整理一下' }), (id) => { cleared.push(id); });
    expect(text).toBe('把报告整理一下');
    expect(cleared).toEqual(['s1']);
  });

  it('没有排队记录 / 正文是空白 → null,但照样清', () => {
    const cleared: string[] = [];
    expect(takeQueuedTextForRemoval('s1', () => null, (id) => { cleared.push(id); })).toBeNull();
    expect(takeQueuedTextForRemoval('s1', () => ({ content: '  ' }), (id) => { cleared.push(id); })).toBeNull();
    expect(cleared).toEqual(['s1', 's1']);
  });

  it('存储读 / 写抛异常都不往外抛(隐私模式、存储被禁)', () => {
    const throwing = () => { throw new Error('storage blocked'); };
    expect(takeQueuedTextForRemoval('s1', throwing, () => {})).toBeNull();
    expect(takeQueuedTextForRemoval('s1', () => ({ content: 'x' }), throwing)).toBe('x');
  });
});

describe('carryDraftKey', () => {
  it('与新建会话页的草稿键是同一个(项目键)—— 换草稿 effect 才能把它恢复到输入框', () => {
    expect(carryDraftKey('proj-1')).toBe(draftStorageKey(null, 'proj-1'));
    expect(carryDraftKey(null)).toBeNull();
  });
});

const handlers = readFileSync(fileURLToPath(new URL('../hooks/useChatRealtimeHandlers.ts', import.meta.url)), 'utf8');
const projectsState = readFileSync(fileURLToPath(new URL('../../../hooks/useProjectsState.ts', import.meta.url)), 'utf8');
const chatInterface = readFileSync(fileURLToPath(new URL('../view/ChatInterface.tsx', import.meta.url)), 'utf8');

describe('接线(读源码钉住,vitest 这边挂不起组件)', () => {
  it('实时处理器:chat.send 的 SESSION_NOT_FOUND 不再落成红字行,而是停转圈、清排队、切态', () => {
    expect(handlers).toMatch(/if \(errorSid && isSessionGoneProtocolError\(\{ code: msg\.code, request: msg\.request \}\)\) \{/);
    expect(handlers).toMatch(/const carried = takeQueuedTextForRemoval\(errorSid, readQueuedMessage, clearQueuedMessage\);\s*\n\s*onSessionRemoved\?\.\(errorSid, removedInfoFromNotFound\(carried\)\);/);
    expect(handlers).toMatch(/case 'session_removed': \{[\s\S]*?takeQueuedTextForRemoval\(sid, readQueuedMessage, clearQueuedMessage\)[\s\S]*?onSessionRemoved\?\.\(sid, removedInfoFromFrame\(msg as Record<string, unknown>, carried\)\)/);
  });

  it('恢复后的 session_upserted 撤掉「已被删除」态', () => {
    expect(handlers).toMatch(/case 'session_upserted':\s*\n[\s\S]*?if \(sid\) onSessionRestored\?\.\(sid\);/);
  });

  it('侧栏:session_removed 只拿掉列表项,不把正在看的那条置空、不导航走', () => {
    expect(projectsState).toMatch(/if \(event\.kind === 'session_removed'\) \{[\s\S]*?removeSessionFromProject\(project, eventSessionId\)[\s\S]*?return;\s*\n\s*\}/);
    const block = projectsState.slice(projectsState.indexOf("if (event.kind === 'session_removed')"), projectsState.indexOf("if (event.kind !== 'session_upserted')"));
    expect(block).not.toMatch(/setSelectedSession\(null\)|navigate\(/);
  });

  it('对话区:已删除态下输入框换成说明卡,错误行不再给「重发上一条」', () => {
    expect(chatInterface).toMatch(/onRetryLastTurn=\{viewedRemovedInfo \? undefined : handleRetryLastTurn\}/);
    expect(chatInterface).toMatch(/\{viewedRemovedInfo \? \(\s*<SessionRemovedNotice/);
    // 「新建会话继续」先把草稿(输入框里的 + 排队卡上那条)写进项目键,再切新建会话
    expect(chatInterface).toMatch(/const key = carryDraftKey\(selectedProject\.projectId\);\s*\n\s*if \(draft && key\) safeLocalStorage\.setItem\(key, draft\);\s*\n\s*onStartNewSession\(selectedProject\);/);
    expect(chatInterface).toMatch(/const parts = \[viewedRemovedInfo\?\.queuedText \?\? '', input\]/);
  });
});
