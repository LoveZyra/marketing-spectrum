import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { isImeComposing, shouldCyclePermissionMode } from './composerKeys';

describe('hl(静态 P2-30)输入法回车与 Tab', () => {
  test('Safari 确认候选:isComposing=false 但 keyCode=229 → 仍算组合中', () => {
    assert.equal(isImeComposing({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 229 } }), true);
    assert.equal(isImeComposing({ key: 'Enter', nativeEvent: { isComposing: true, keyCode: 13 } }), true);
    assert.equal(isImeComposing({ key: 'Enter', nativeEvent: { isComposing: false, keyCode: 13 } }), false);
    assert.equal(isImeComposing({ key: 'Enter', isComposing: false, keyCode: 229 }), true);
  });

  test('只有 Shift+Tab 切模式;普通 Tab 留给焦点移动(不再是键盘陷阱)', () => {
    assert.equal(shouldCyclePermissionMode({ key: 'Tab', shiftKey: true }), true);
    assert.equal(shouldCyclePermissionMode({ key: 'Tab' }), false);
    assert.equal(shouldCyclePermissionMode({ key: 'Tab', shiftKey: true, ctrlKey: true }), false);
    assert.equal(shouldCyclePermissionMode({ key: 'Enter', shiftKey: true }), false);
  });
});
