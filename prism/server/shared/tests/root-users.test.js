import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { isApprovalRequired, isRootUser, listRootUsernames } from '../root-users.js';

describe('root 账号与注册审批闸门', () => {
  test('未配置时没有人是 root —— 默认不给权限,而不是默认全给', () => {
    assert.equal(isRootUser('anyone', {}), false);
    assert.equal(isRootUser('anyone', { PRISM_ROOT_USERS: '' }), false);
    assert.equal(isRootUser('anyone', { PRISM_ROOT_USERS: '   ' }), false);
    assert.deepEqual(listRootUsernames({}), []);
  });

  test('大小写与空白不影响判定 —— 配置常被手抄出空格', () => {
    const env = { PRISM_ROOT_USERS: ' Tianji.Chang , alice ' };
    assert.equal(isRootUser('tianji.chang', env), true);
    assert.equal(isRootUser('TIANJI.CHANG', env), true);
    assert.equal(isRootUser('  alice  ', env), true);
    assert.deepEqual(listRootUsernames(env).sort(), ['alice', 'tianji.chang']);
  });

  test('不是 root 的人一律 false,空值不炸', () => {
    const env = { PRISM_ROOT_USERS: 'tianji.chang' };
    assert.equal(isRootUser('bob', env), false);
    assert.equal(isRootUser('', env), false);
    assert.equal(isRootUser(undefined, env), false);
    assert.equal(isRootUser(null, env), false);
    // 前缀/子串不能蒙混过关
    assert.equal(isRootUser('tianji', env), false);
    assert.equal(isRootUser('tianji.chang.evil', env), false);
  });

  test('审批闸门默认开启,只有显式 0 才关', () => {
    assert.equal(isApprovalRequired({}), true);
    assert.equal(isApprovalRequired({ PRISM_APPROVAL_REQUIRED: '1' }), true);
    assert.equal(isApprovalRequired({ PRISM_APPROVAL_REQUIRED: 'true' }), true);
    assert.equal(isApprovalRequired({ PRISM_APPROVAL_REQUIRED: '0' }), false);
    assert.equal(isApprovalRequired({ PRISM_APPROVAL_REQUIRED: ' 0 ' }), false);
  });
});
