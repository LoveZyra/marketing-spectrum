/**
 * dy:工作面板"预览开着就让位"的折叠策略。
 *
 * 布局是 `[聊天正文 + 工作面板][文件预览栏]`,工作面板是 flex-none 的
 * 300(xl:320)px —— 预览栏一出现,被挤掉的只能是聊天正文(实测压成一条
 * 竖着堆芯片的窄条)。预览开着时正文比清单要紧,所以面板自动折成窄边条。
 *
 * 难点全在"别把用户的选择弄丢",所以规则抽成纯函数在这里钉死:
 *
 *  1. 只有**本来展开**时才自动折,并记 `auto = true`;本来就折着的,与自动
 *     折叠无关,`auto` 保持 false。
 *  2. 预览关掉时,只还原 `auto` 的那一次;不是我折的就不动。
 *  3. 用户在预览开着时手动拨了开关 → `auto` 立即作废,关预览时不再覆盖他
 *     刚做的选择。
 *  4. 只有**手动**那次才写 localStorage —— 那里记的是用户偏好,不是这次
 *     临时让位。自动折/自动还原都不落盘。
 */

export interface AutoCollapseState {
  /** 面板当前是否折起来。 */
  collapsed: boolean;
  /** 当前的折叠是不是"预览自动折的"—— 只有它为真才会自动还原。 */
  auto: boolean;
}

/**
 * 预览开/关时的状态迁移。
 *
 * 永远**新造**一个只含这两个字段的对象,不把入参原样透回去 —— 调用方可能
 * 把 `applyManualToggle` 的结果(多一个 `persist`)直接喂进来,原样透回会让
 * 那个字段一路带进 state,之后被人当真读到。
 */
export function applyPreviewChange(state: AutoCollapseState, previewOpen: boolean): AutoCollapseState {
  if (previewOpen) {
    // 本来就折着 —— 不是我折的,别认领(auto 保持原样)
    if (state.collapsed) return { collapsed: true, auto: state.auto };
    return { collapsed: true, auto: true };
  }
  if (!state.auto) return { collapsed: state.collapsed, auto: false }; // 不是我折的,不还原
  return { collapsed: false, auto: false };
}

/** 用户点折叠/展开按钮。`persist` 为真表示这次要写进 localStorage。 */
export function applyManualToggle(state: AutoCollapseState): AutoCollapseState & { persist: boolean } {
  return { collapsed: !state.collapsed, auto: false, persist: true };
}
