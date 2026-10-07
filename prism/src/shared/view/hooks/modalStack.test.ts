import assert from 'node:assert/strict';

import { beforeEach, describe, test } from 'vitest';

import { isLocalEscapeTarget, isTopModal, pushModal, removeModal, resetModalStack } from './modalStack';

describe('弹层栈', () => {
  beforeEach(() => resetModalStack());

  test('向导里再开「选择文件夹」:只有栈顶那层处理 Esc(基线两层都处理,整个向导一起关)', () => {
    const wizard = pushModal();
    const folderBrowser = pushModal();
    assert.equal(isTopModal(folderBrowser), true);
    assert.equal(isTopModal(wizard), false);
    removeModal(folderBrowser);
    assert.equal(isTopModal(wizard), true);
  });

  test('非栈顶的层先关掉也不打乱顺序', () => {
    const a = pushModal();
    const b = pushModal();
    const c = pushModal();
    removeModal(b);
    assert.equal(isTopModal(c), true);
    removeModal(c);
    assert.equal(isTopModal(a), true);
  });

  test('行内输入框(data-esc-local / data-inline-rename)的 Esc 留给它自己', () => {
    const inside = (selector: string) => ({ closest: (s: string) => (s.includes(selector) ? {} : null) });
    assert.equal(isLocalEscapeTarget(inside('[data-esc-local]')), true);
    assert.equal(isLocalEscapeTarget({ closest: () => null }), false);
    assert.equal(isLocalEscapeTarget(null), false);
  });
});
