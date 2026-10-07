import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import CommandMenu from '../view/subcomponents/CommandMenu';

import { composerAutocompleteAria, listOptionId } from './composerAutocompleteAria';

/**
 * 斜杠命令 / @ 文件下拉对读屏可感知,「+」菜单有菜单该有的键盘行为。
 *
 * 焦点一直在输入框上,方向键改的是下拉里的高亮项;输入框不指向那一项,读屏什么都不念。
 */
const base = {
  commandListId: 'ac-commands',
  commandListShown: false,
  selectedCommandIndex: -1,
  fileListId: 'ac-files',
  fileListShown: false,
  selectedFileIndex: -1,
};

describe('composerAutocompleteAria', () => {
  it('没有下拉时只声明会弹候选,不指向任何东西', () => {
    expect(composerAutocompleteAria(base)).toEqual({ 'aria-autocomplete': 'list' });
  });

  it('斜杠命令下拉:指向列表与键盘选中的那一项', () => {
    expect(composerAutocompleteAria({ ...base, commandListShown: true, selectedCommandIndex: 2 })).toEqual({
      'aria-autocomplete': 'list',
      'aria-controls': 'ac-commands',
      'aria-activedescendant': 'ac-commands-option-2',
    });
  });

  it('还没用键盘选中任何一项时只指向列表', () => {
    expect(composerAutocompleteAria({ ...base, fileListShown: true })).toEqual({
      'aria-autocomplete': 'list',
      'aria-controls': 'ac-files',
    });
  });

  it('两个都开着时以斜杠命令为准(与按键处理的先后一致)', () => {
    const aria = composerAutocompleteAria({
      ...base,
      commandListShown: true,
      selectedCommandIndex: 0,
      fileListShown: true,
      selectedFileIndex: 3,
    });
    expect(aria['aria-activedescendant']).toBe(listOptionId('ac-commands', 0));
  });
});

describe('CommandMenu 的列表语义', () => {
  const commands = [
    { name: '/compact', namespace: 'builtin' },
    { name: '/review', namespace: 'skill' },
    { name: '/clear', namespace: 'builtin' },
  ];
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(
    React.createElement(CommandMenu, { id: 'cm', commands, isOpen: true, onClose: () => {}, ...props }),
  );

  it('列表与每一项都有稳定 id,输入框的 aria-activedescendant 指得到', () => {
    const html = render({ selectedIndex: 1 });
    expect(html).toContain('id="cm" role="listbox"');
    for (const index of [0, 1, 2]) expect(html).toContain(`id="${listOptionId('cm', index)}"`);
  });

  it('aria-selected 只跟键盘选中走,鼠标悬停那一项不算', () => {
    const html = render({ selectedIndex: 2, hoveredIndex: 0 });
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`id="${listOptionId('cm', 2)}"[^>]*aria-selected="true"`));
    expect(html).toMatch(new RegExp(`id="${listOptionId('cm', 0)}"[^>]*aria-selected="false"`));
  });
});

describe('接线', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const composer = read('../view/subcomponents/ChatComposer.tsx');

  it('输入框带上 aria-controls / aria-activedescendant,斜杠命令下拉拿到列表 id', () => {
    const textarea = composer.slice(composer.indexOf('<PromptInputTextarea'), composer.indexOf('/>', composer.indexOf('<PromptInputTextarea')));
    expect(textarea).toContain('{...autocompleteAria}');
    expect(composer).toMatch(/<CommandMenu\s+id=\{commandListId\}/);
  });

  it('@ 文件下拉是 listbox,每项是带 id 的 option,aria-selected 跟键盘选中走', () => {
    expect(composer).toMatch(/id=\{fileListId\}\s+role="listbox"/);
    expect(composer).toMatch(/id=\{listOptionId\(fileListId, index\)\}\s+role="option"\s+aria-selected=\{index === selectedFileIndex\}/);
  });

  // 「+」菜单的焦点与按键行为由 view/subcomponents/ComposerPlusMenu.keyboard.test.ts 直接驱动组件钉住
});
