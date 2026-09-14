import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { resolveResumeProjectPath } from '../routes/agent.js';

/**
 * F05:**续会话时,工作目录只能是这条会话登记的那个。**
 *
 * 外部 API 这条路上,`finalProjectPath` 完全来自请求(`projectPath` / 克隆目标),
 * 而会话行里有它自己的 `project_path` —— 两者可以不一样,而且这个端点是以
 * bypassPermissions 起 Claude 的。
 *
 * 不校验的后果是"续 A 会话的对话,却在 B 目录里执行":transcript 记的是 A 的
 * 历史,改的却是 B 的文件,侧栏、检查点、附件归属全都按 A 记账。
 * 网页那条路早就收口了(`cwd` 只从会话行取),外部 API 一直没有。
 */
describe('resolveResumeProjectPath', () => {
  test('不给路径 → 用会话自己的(这才是"续会话"的本意)', () => {
    const out = resolveResumeProjectPath('/work/proj-a', '/work/proj-a', false);
    assert.deepEqual(out, { ok: true, projectPath: '/work/proj-a' });
  });

  test('给的路径和会话登记的一致 → 放行', () => {
    const out = resolveResumeProjectPath('/work/proj-a', '/work/proj-a', true);
    assert.deepEqual(out, { ok: true, projectPath: '/work/proj-a' });
  });

  test('给的路径**不一样** → 拒绝,而不是静默改写', () => {
    // 悄悄换掉一个调用方明明白白传进来的目录,比报错更难查。
    const out = resolveResumeProjectPath('/work/proj-a', '/work/proj-b', true);
    assert.equal(out.ok, false);
    assert.deepEqual(out.conflict, {
      sessionProjectPath: '/work/proj-a',
      requestedProjectPath: '/work/proj-b',
    });
  });

  test('没显式给路径时,即使解析出来的不一样也按会话那个跑', () => {
    // 这一支对应"只传 sessionId":requestedProjectPath 是兜底推出来的,
    // 不该因为它与会话不符就把整个请求拒掉。
    const out = resolveResumeProjectPath('/work/proj-a', '/tmp/whatever', false);
    assert.deepEqual(out, { ok: true, projectPath: '/work/proj-a' });
  });

  test('会话没登记路径(老行)→ 按请求那个跑,不拦', () => {
    const out = resolveResumeProjectPath(null, '/work/proj-b', true);
    assert.deepEqual(out, { ok: true, projectPath: '/work/proj-b' });
  });

  test('会话路径为空串同样按"没登记"处理', () => {
    const out = resolveResumeProjectPath('', '/work/proj-b', true);
    assert.deepEqual(out, { ok: true, projectPath: '/work/proj-b' });
  });
});
