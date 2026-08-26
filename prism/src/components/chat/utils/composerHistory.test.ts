import { describe, test, expect } from 'vitest';

import { stepHistoryWalk, type HistoryWalkState } from './composerHistory';

/**
 * F2 回归:↑/↓ 历史回填(readline 风格)。
 */
describe('stepHistoryWalk', () => {
  const history = () => ['第一条', '第二条', '第三条'];

  test('空输入按 ↑:进入回看,回填最新一条', () => {
    const step = stepHistoryWalk(null, 'back', history, '');
    expect(step.input).toBe('第三条');
    expect(step.state?.index).toBe(2);
  });

  test('输入框有内容时 ↑ 不接管(保持光标移动)', () => {
    const step = stepHistoryWalk(null, 'back', history, '正在打字');
    expect(step.input).toBeNull();
    expect(step.state).toBeNull();
  });

  test('未进入回看时 ↓ 不接管', () => {
    const step = stepHistoryWalk(null, 'forward', history, '');
    expect(step.input).toBeNull();
  });

  test('连续 ↑ 往更早走,到最早一条后原地不动', () => {
    const state: HistoryWalkState = stepHistoryWalk(null, 'back', history, '').state;
    let step = stepHistoryWalk(state, 'back', history, '第三条');
    expect(step.input).toBe('第二条');
    step = stepHistoryWalk(step.state, 'back', history, '第二条');
    expect(step.input).toBe('第一条');
    // 已到最早:仍接管(避免光标乱跳)但内容不变
    step = stepHistoryWalk(step.state, 'back', history, '第一条');
    expect(step.input).toBe('第一条');
    expect(step.state?.index).toBe(0);
  });

  test('↓ 往更新走,越过最新一条退出并恢复进入前输入', () => {
    let step = stepHistoryWalk(null, 'back', history, '');
    step = stepHistoryWalk(step.state, 'back', history, step.input!);
    expect(step.input).toBe('第二条');
    step = stepHistoryWalk(step.state, 'forward', history, step.input!);
    expect(step.input).toBe('第三条');
    step = stepHistoryWalk(step.state, 'forward', history, step.input!);
    expect(step.input).toBe(''); // 恢复进入前的空输入
    expect(step.state).toBeNull();
  });

  test('历史列表相邻去重、去空白', () => {
    const step = stepHistoryWalk(null, 'back', () => ['a', 'a', '  ', 'b', 'b', 'a'], '');
    expect(step.state?.list).toEqual(['a', 'b', 'a']);
    expect(step.input).toBe('a');
  });

  test('历史为空:↑ 不接管', () => {
    const step = stepHistoryWalk(null, 'back', () => [], '');
    expect(step.input).toBeNull();
    expect(step.state).toBeNull();
  });
});
