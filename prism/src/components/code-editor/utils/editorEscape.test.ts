import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveEditorEscapeAction } from './editorEscape';

/**
 * ec:预览面板「最大化」。
 *
 * 用户要的是"可展示的文件(渲染出来的 HTML / Markdown / notebook / 图片 / PDF)
 * 也能放大看"。放大的机制(editorExpanded → 左栏 display:none、预览栏 flex-1)
 * 早就有,只是开关藏在 CodeMirror 的工具条里 —— 而上面这些形态根本不经过
 * CodeMirror。现在开关统一在头部,三种头部(文本编辑器 / 媒体预览 / 二进制占位)
 * 都有;Esc 先还原再关。
 */
describe('resolveEditorEscapeAction', () => {
  it('侧栏 + 已最大化 + 有开关 → 第一次 Esc 只还原', () => {
    expect(resolveEditorEscapeAction({ isSidebar: true, isExpanded: true, hasToggleExpand: true })).toBe('restore');
  });

  it('没最大化 → 关闭(老行为)', () => {
    expect(resolveEditorEscapeAction({ isSidebar: true, isExpanded: false, hasToggleExpand: true })).toBe('close');
  });

  it('弹出的浮层里没有"最大化"概念 → 关闭', () => {
    expect(resolveEditorEscapeAction({ isSidebar: false, isExpanded: true, hasToggleExpand: true })).toBe('close');
  });

  it('没有还原开关时不能停在"还原"上 → 关闭', () => {
    expect(resolveEditorEscapeAction({ isSidebar: true, isExpanded: true, hasToggleExpand: false })).toBe('close');
  });
});

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('「最大化 / 还原」开关在三种头部都有(源码守门)', () => {
  it.each([
    ['../view/subcomponents/CodeEditorHeader.tsx', /isSidebar && onToggleExpand && \(/],
    ['../view/subcomponents/CodeEditorMediaPreview.tsx', /isSidebar && onToggleExpand && \(/],
    ['../view/subcomponents/CodeEditorBinaryFile.tsx', /onToggleExpand && \(/],
  ])('%s', (relative, guard) => {
    const source = read(relative);
    expect(source).toMatch(guard);
    // 探针与实机测试都靠这个标记找按钮;按钮要带 aria-pressed 表达当前态。
    expect(source).toMatch(/data-editor-maximize/);
    expect(source).toMatch(/aria-pressed=\{isExpanded\}/);
  });

  it('CodeMirror 工具条不再放第二个同款开关', () => {
    const source = read('../view/CodeEditor.tsx');
    expect(source).toMatch(/onToggleExpand: null/);
  });

  it('最大化时不做"窄了就弹出浮层"的判定', () => {
    const source = read('../view/EditorSidebar.tsx');
    expect(source).toMatch(/if \(editorExpanded\) return;/);
    expect(source).toMatch(/data-maximized=\{editorExpanded \? 'true' : undefined\}/);
  });
});

describe('ee:最大化时项目侧栏也收起(源码守门)', () => {
  it('MainContent 把 editorExpanded 通知上层;AppContent 据此折叠侧栏而不写偏好', () => {
    const main = read('../../main-content/view/MainContent.tsx');
    expect(main).toMatch(/onEditorMaximizedChange\?\.\(editorExpanded\)/);
    const app = read('../../app/AppContent.tsx');
    expect(app).toMatch(/const isSidebarCollapsed = !isMobile && \(!uiPreferences\.sidebarVisible \|\| editorMaximized\)/);
    expect(app).toMatch(/onEditorMaximizedChange=\{setEditorMaximized\}/);
    // 不能走 setPreference:那会把用户自己的侧栏开合状态覆盖掉
    expect(app).not.toMatch(/setPreference\('sidebarVisible', !?editorMaximized/);
  });
});
