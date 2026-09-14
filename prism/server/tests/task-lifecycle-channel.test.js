import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import { taskLifecycleMessage } from '../claude-sdk.js';

/**
 * gb:**SDK 的任务生命周期通道 → Prism 的显示行。**
 *
 * 线上现象:让模型开几个后台子 agent,界面永远停在「✅ 3 个已启动」,完成汇报
 * 一条都看不到,刷新也没有。查下来病根有两层:
 *
 *   1. 完成汇报本来是一条**结构化的 SDK 消息**(`type:'system'` /
 *      `subtype:'task_notification'`,带 `status` / `summary` / `output_file` /
 *      `usage`),而 `claude-sdk.js` 的读循环只认 `system/status` 与
 *      `system/compact_boundary` —— **这条通道从来没接过**;
 *   2. 它到达时那一轮是 CLI 自己发起的,`runtime.turn` 是 null,于是连同模型的
 *      回复一起在 `if (!turn) continue` 处整轮丢掉(见 observed-run 那一侧)。
 *
 * 这一份钉第 1 层:**通道接对了没有**。
 */
describe('taskLifecycleMessage', () => {
  const base = { type: 'system', session_id: 'p1', uuid: 'u1' };

  it('完成通知 → 一条带 summary 的 task_notification', () => {
    const row = taskLifecycleMessage({
      ...base,
      subtype: 'task_notification',
      task_id: 'ab67282f5aa2d91fa',
      status: 'completed',
      summary: '子 agent 1/3 完成:已核对 12 个文件',
      output_file: '/tmp/agent-1.md',
      usage: { total_tokens: 1200, tool_uses: 7, duration_ms: 8400 },
    }, 's1');
    assert.ok(row);
    assert.equal(row.kind, 'task_notification');
    assert.equal(row.status, 'completed');
    assert.equal(row.sessionId, 's1');
    assert.match(row.summary, /✅ 后台任务完成/);
    assert.match(row.summary, /8s/);
    assert.match(row.summary, /7 次工具/);
    /**
     * gf:**`summary` 只有一行,全文在 `content` 里。**
     *
     * 前端拿 `summary` 当"这张卡的后台状态"用(subagentState.background.summary)。
     * gd 把 head/usage/全文塞进同一个字符串,于是子代理卡展开后顶出一坨没排版的
     * 长文 —— 用户原话「后台任务完成这个详细信息……现在不好看」。
     *
     * 拆开之后两件事都成立:卡片拿到的是一行;显示日志与 transcript 里全文一个字不丢。
     */
    assert.ok(!row.summary.includes('\n'), `summary 必须是一行,实际:${JSON.stringify(row.summary)}`);
    assert.ok(!row.summary.includes('已核对 12 个文件'));
    assert.match(row.content, /✅ 后台任务完成/);
    assert.match(row.content, /子 agent 1\/3 完成:已核对 12 个文件/);
  });

  it('失败 / 被停都落成 failed,文案分得开', () => {
    const failed = taskLifecycleMessage({ ...base, subtype: 'task_notification', task_id: 't', status: 'failed', summary: '命令返回 1' }, 's1');
    assert.equal(failed.status, 'failed');
    assert.match(failed.summary, /⚠️ 后台任务失败/);

    const stopped = taskLifecycleMessage({ ...base, subtype: 'task_notification', task_id: 't2', status: 'stopped', summary: '用户停止' }, 's1');
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.summary, /⏹ 后台任务已停止/);
  });

  it('同一条通知重复到达时 id 稳定 —— 显示日志靠 (session_id, message_id) 去重', () => {
    const make = () => taskLifecycleMessage({ ...base, subtype: 'task_notification', task_id: 'same-task', status: 'completed', summary: 'x' }, 's1');
    assert.equal(make().id, make().id);
    // 不同任务不能撞
    const other = taskLifecycleMessage({ ...base, subtype: 'task_notification', task_id: 'other-task', status: 'completed', summary: 'x' }, 's1');
    assert.notEqual(make().id, other.id);
  });

  it('task_started 带 tool_use_id 的**不画** —— 子代理卡已经在画它了', () => {
    const withTool = taskLifecycleMessage({
      ...base, subtype: 'task_started', task_id: 't', tool_use_id: 'toolu_1',
      description: '核对文件', subagent_type: 'Explore',
    }, 's1');
    assert.equal(withTool, null);
  });

  it('task_started 没有 tool_use_id 的画一行(转后台的 Bash / workflow)', () => {
    const row = taskLifecycleMessage({
      ...base, subtype: 'task_started', task_id: 't', description: '跑 pytest 全量',
    }, 's1');
    assert.ok(row);
    assert.equal(row.kind, 'task_notification');
    assert.equal(row.status, 'running');
    assert.match(row.summary, /跑 pytest 全量/);
  });

  it('skip_transcript 一律不画 —— CLI 明说了这是杂活', () => {
    assert.equal(taskLifecycleMessage({ ...base, subtype: 'task_started', task_id: 't', description: 'x', skip_transcript: true }, 's1'), null);
    assert.equal(taskLifecycleMessage({ ...base, subtype: 'task_notification', task_id: 't', status: 'completed', summary: 'x', skip_transcript: true }, 's1'), null);
  });

  it('task_updated 不接(那是要前端维护任务表来合并的 patch)', () => {
    assert.equal(taskLifecycleMessage({ ...base, subtype: 'task_updated', task_id: 't', patch: {} }, 's1'), null);
  });

  it('别的 system 消息不碰(压缩边界、状态)', () => {
    assert.equal(taskLifecycleMessage({ ...base, subtype: 'compact_boundary' }, 's1'), null);
    assert.equal(taskLifecycleMessage({ ...base, subtype: 'status', status: 'compacting' }, 's1'), null);
    assert.equal(taskLifecycleMessage({ type: 'assistant', message: {} }, 's1'), null);
  });
});

/**
 * gd:**进展与汇报要带 `tool_use_id` —— 那是子代理卡的身份。**
 *
 * 任务一转后台,那次工具调用**立刻**拿到一个 "running in the background" 的
 * tool_result(SDK 原话),子代理卡当场收工、步数停在那儿;之后的一切只在
 * `task_progress` / `task_notification` 里。不把 `tool_use_id` 带出来,
 * 前端就没有任何办法把它们归回那张卡 —— 线上看到的「2 步 ✓ + 另起一行的汇报」
 * 就是这么来的。
 */
describe('gd:任务行带上卡片身份', () => {
  const base = { type: 'system', session_id: 'p1', uuid: 'u1' };

  it('进展 → task_progress(**不是** task_notification,它不进 durable 白名单)', () => {
    const row = taskLifecycleMessage({
      ...base,
      subtype: 'task_progress',
      task_id: 't1',
      tool_use_id: 'toolu_X',
      description: '审计:发送与排队',
      last_tool_name: 'Bash',
      usage: { total_tokens: 9000, tool_uses: 46, duration_ms: 61000 },
    }, 's1');
    assert.ok(row);
    assert.equal(row.kind, 'task_progress');
    assert.equal(row.toolId, 'toolu_X');
    assert.equal(row.taskId, 't1');
    assert.equal(row.taskProgress.toolUses, 46);
    assert.equal(row.taskProgress.lastToolName, 'Bash');
  });

  it('同一个任务的进展**同一个 id** —— 直播按 id upsert,不堆成一串', () => {
    const make = (n) => taskLifecycleMessage({
      ...base, subtype: 'task_progress', task_id: 't1', tool_use_id: 'toolu_X',
      description: 'x', usage: { tool_uses: n },
    }, 's1');
    assert.equal(make(3).id, make(40).id);
  });

  it('进展没有 tool_use_id 就丢掉 —— 没有卡可归,在主流里滚是纯噪音', () => {
    assert.equal(taskLifecycleMessage({
      ...base, subtype: 'task_progress', task_id: 't1', description: 'x', usage: {},
    }, 's1'), null);
  });

  it('汇报带 tool_use_id 时把它带出来(前端据此归卡)', () => {
    const row = taskLifecycleMessage({
      ...base, subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_X',
      status: 'completed', summary: '已核对 12 个文件',
      usage: { tool_uses: 46, duration_ms: 61000 },
    }, 's1');
    assert.equal(row.toolId, 'toolu_X');
    assert.equal(row.taskProgress.toolUses, 46);
  });

  it('汇报没有 tool_use_id 时不带 —— 它本来就没有卡,照旧独立成行', () => {
    const row = taskLifecycleMessage({
      ...base, subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'x',
    }, 's1');
    assert.equal(row.toolId, undefined);
  });
});
