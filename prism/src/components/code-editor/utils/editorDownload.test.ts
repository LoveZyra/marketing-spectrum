import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { chooseEditorDownload } from './editorDownload';

const base = { loadError: false, isDiffView: false, hasUnsavedChanges: false, canIssueTicket: true };

describe('编辑器下载的来源', () => {
  test('读失败不下载', () => {
    assert.equal(chooseEditorDownload({ ...base, loadError: true, hasUnsavedChanges: true }), 'blocked');
  });
  test('有未保存改动下缓冲区,而不是磁盘上的旧版本', () => {
    assert.equal(chooseEditorDownload({ ...base, hasUnsavedChanges: true }), 'buffer');
  });
  test('没改动:签票下原件;diff 视图 / 签不了票:缓冲区', () => {
    assert.equal(chooseEditorDownload(base), 'ticket');
    assert.equal(chooseEditorDownload({ ...base, isDiffView: true }), 'buffer');
    assert.equal(chooseEditorDownload({ ...base, canIssueTicket: false }), 'buffer');
  });
});
