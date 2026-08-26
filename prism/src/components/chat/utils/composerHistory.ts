/**
 * 输入框的 ↑/↓ 历史回填(readline 风格)。
 *
 * 规则:
 * - 只在**输入框为空**时按 ↑ 才进入回看;有内容时 ↑/↓ 保持光标移动的本义。
 * - 进入回看时对历史列表做快照(相邻去重、去空行),↑ 往更早走、↓ 往更新走;
 * - ↓ 越过最新一条即退出回看,恢复进入前暂存的输入(通常是空串);
 * - 一旦用户开始打字,调用方应把 walk 状态清空(编辑过的内容不再当历史看)。
 *
 * 纯函数 + 外置状态,方便单测;副作用(setInput、光标定位)由调用方处理。
 */

export type HistoryWalkState = {
  list: string[];
  index: number;
  stashedInput: string;
} | null;

export type HistoryWalkStep = {
  state: HistoryWalkState;
  /** 要回填到输入框的内容;null = 本次按键不接管(走浏览器默认行为)。 */
  input: string | null;
};

function normalizeHistory(raw: string[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const text = typeof item === 'string' ? item : '';
    if (!text.trim()) continue;
    if (out.length > 0 && out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out;
}

export function stepHistoryWalk(
  state: HistoryWalkState,
  direction: 'back' | 'forward',
  getHistory: () => string[],
  currentInput: string,
): HistoryWalkStep {
  if (!state) {
    if (direction === 'forward') {
      return { state: null, input: null };
    }
    if (currentInput.trim() !== '') {
      // 输入框有内容:↑ 是光标移动,不抢。
      return { state: null, input: null };
    }
    const list = normalizeHistory(getHistory());
    if (list.length === 0) {
      return { state: null, input: null };
    }
    const index = list.length - 1;
    return { state: { list, index, stashedInput: currentInput }, input: list[index] };
  }

  if (direction === 'back') {
    if (state.index === 0) {
      // 已到最早一条:原地不动(但仍接管按键,避免光标乱跳)。
      return { state, input: state.list[0] };
    }
    const index = state.index - 1;
    return { state: { ...state, index }, input: state.list[index] };
  }

  const index = state.index + 1;
  if (index >= state.list.length) {
    // 越过最新一条:退出回看,恢复进入前的输入。
    return { state: null, input: state.stashedInput };
  }
  return { state: { ...state, index }, input: state.list[index] };
}
