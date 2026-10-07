/** 下拉里第 `index` 项的 DOM id,输入框的 aria-activedescendant 指向它。 */
export function listOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

export interface ComposerAutocompleteState {
  commandListId: string;
  /** 斜杠命令下拉开着且有候选(没有候选时画的是"暂无可用命令",没有列表)。 */
  commandListShown: boolean;
  selectedCommandIndex: number;
  fileListId: string;
  /** @ 文件下拉开着且有候选。 */
  fileListShown: boolean;
  selectedFileIndex: number;
}

export interface ComposerAutocompleteAria {
  'aria-autocomplete': 'list';
  'aria-controls'?: string;
  'aria-activedescendant'?: string;
}

/**
 * 输入框在斜杠命令 / @ 文件下拉打开时的 ARIA。
 *
 * 焦点一直留在 textarea 上,方向键改的是下拉里的高亮项。textarea 不指向那一项的话,读屏什么都不念,
 * 用户不知道选中了哪条、回车会插入什么。所以 textarea 用 aria-controls 指向下拉,用
 * aria-activedescendant 指向键盘选中的那一项;鼠标悬停不算,回车也只认键盘选中的。
 * 两个下拉同时开着时以斜杠命令为准,与按键处理的先后一致(见 useChatComposerState 的 handleKeyDown)。
 *
 * textarea 保持原生的 textbox 角色:这三个属性 textbox 都支持,combobox 角色不允许用在 textarea 上。
 */
export function composerAutocompleteAria(state: ComposerAutocompleteState): ComposerAutocompleteAria {
  const active = state.commandListShown
    ? { listId: state.commandListId, index: state.selectedCommandIndex }
    : state.fileListShown
      ? { listId: state.fileListId, index: state.selectedFileIndex }
      : null;
  if (!active) return { 'aria-autocomplete': 'list' };
  return {
    'aria-autocomplete': 'list',
    'aria-controls': active.listId,
    ...(active.index >= 0 ? { 'aria-activedescendant': listOptionId(active.listId, active.index) } : {}),
  };
}
