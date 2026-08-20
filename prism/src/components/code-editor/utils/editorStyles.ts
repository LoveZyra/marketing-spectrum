/**
 * CodeMirror 侧的主题补丁,跟随明暗两版走设计语言:
 * 深色底 #101010 / 浅色底 #ffffff,发丝线 #3d3a39(浅色 16% 透明),
 * 增行 8% 绿,删行不上红底 —— 只弱化 + 左侧发丝线标记(与聊天区 diff 同口径)。
 */
const DARK = {
  canvas: '#101010',
  soft: '#1a1a1a',
  hairline: '#3d3a39',
  gutter: '#3d3a39',
  mute: '#8b949e',
  ink: '#f2f2f2',
  addBg: 'rgba(0, 217, 146, 0.08)',
  addBar: 'rgba(0, 217, 146, 0.32)',
  addText: 'rgba(0, 217, 146, 0.16)',
};

const LIGHT = {
  canvas: '#ffffff',
  soft: '#f5f6f7',
  hairline: 'rgba(61, 58, 57, 0.16)',
  gutter: 'rgba(61, 58, 57, 0.4)',
  mute: 'rgba(61, 58, 57, 0.72)',
  ink: '#1a1a1a',
  addBg: 'rgba(16, 185, 129, 0.08)',
  addBar: 'rgba(16, 185, 129, 0.32)',
  addText: 'rgba(16, 185, 129, 0.16)',
};

export const getEditorLoadingStyles = (isDarkMode: boolean) => {
  const c = isDarkMode ? DARK : LIGHT;
  return `
    .code-editor-loading {
      background-color: ${c.canvas} !important;
    }

    .code-editor-loading:hover {
      background-color: ${c.canvas} !important;
    }
  `;
};

export const getEditorStyles = (isDarkMode: boolean) => {
  const c = isDarkMode ? DARK : LIGHT;
  return `
    .cm-deletedChunk {
      background-color: transparent !important;
      border-left: 3px solid ${c.hairline} !important;
      color: ${c.mute} !important;
      text-decoration: line-through !important;
      padding-left: 4px !important;
    }

    .cm-insertedChunk {
      background-color: ${c.addBg} !important;
      border-left: 3px solid ${c.addBar} !important;
      padding-left: 4px !important;
    }

    .cm-editor.cm-merge-b .cm-changedText {
      background: ${c.addText} !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      margin-top: -2px !important;
      margin-bottom: -2px !important;
    }

    .cm-editor .cm-deletedChunk .cm-changedText {
      background: transparent !important;
      padding-top: 2px !important;
      padding-bottom: 2px !important;
      margin-top: -2px !important;
      margin-bottom: -2px !important;
    }

    .cm-gutter.cm-gutter-minimap {
      background-color: ${c.soft};
    }

    /* 编辑器画布跟随设计语言(语法高亮配色保留 —— 那是功能性着色,不属品牌色) */
    .cm-editor,
    .cm-editor .cm-scroller,
    .cm-editor .cm-content {
      background-color: ${c.canvas} !important;
    }

    .cm-editor .cm-gutters {
      background-color: ${c.canvas} !important;
      color: ${c.gutter} !important;
      border-right: 1px solid ${c.hairline} !important;
    }

    .cm-editor .cm-activeLine {
      background-color: ${c.soft} !important;
    }

    .cm-editor .cm-activeLineGutter {
      background-color: ${c.soft} !important;
      color: ${c.mute} !important;
    }

    .cm-editor .cm-selectionBackground,
    .cm-editor.cm-focused .cm-selectionBackground {
      background-color: ${c.addText} !important;
    }

    .cm-editor-toolbar-panel {
      padding: 4px 10px;
      background-color: ${c.soft};
      border-bottom: 1px solid ${c.hairline};
      color: ${c.ink};
      font-size: 12px;
    }

    .cm-diff-nav-btn,
    .cm-toolbar-btn {
      padding: 3px;
      background: transparent;
      border: none;
      cursor: pointer;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      transition: background-color 120ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    .cm-diff-nav-btn:hover,
    .cm-toolbar-btn:hover {
      background-color: ${c.soft};
    }

    .cm-diff-nav-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;
};
