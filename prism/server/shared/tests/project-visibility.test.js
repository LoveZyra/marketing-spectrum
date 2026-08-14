import assert from 'node:assert/strict';

import { afterEach, describe, test } from 'vitest';

import { canViewerSeeProject } from '../project-visibility.js';

const ROOT = 'tianji.chang';
const originalRootUsers = process.env.PRISM_ROOT_USERS;

afterEach(() => {
  if (originalRootUsers === undefined) {
    delete process.env.PRISM_ROOT_USERS;
  } else {
    process.env.PRISM_ROOT_USERS = originalRootUsers;
  }
});

describe('项目可见性(列表与实时广播共用)', () => {
  test('公共项目所有人可见,包括没登录信息的连接', () => {
    assert.equal(canViewerSeeProject({ ownerUserId: null, viewerUserId: 7, viewerUsername: 'bob' }), true);
    assert.equal(canViewerSeeProject({ ownerUserId: undefined, viewerUserId: null, viewerUsername: null }), true);
  });

  test('自己的项目看得到,别人的看不到 —— 这就是串台的那一条', () => {
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: 7, viewerUsername: 'bob' }), true);
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: 8, viewerUsername: 'carol' }), false);
  });

  test('id 类型不一致也要认得出是同一个人', () => {
    // 广播路径上 id 有三个来源(JWT、ws ticket、平台模式),类型不保证一致。
    // 按引用比会让用户看不到自己的项目,按字符串比才对。
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: '7', viewerUsername: 'bob' }), true);
    assert.equal(canViewerSeeProject({ ownerUserId: '7', viewerUserId: 7, viewerUsername: 'bob' }), true);
  });

  test('root 看得到别人的项目', () => {
    process.env.PRISM_ROOT_USERS = ROOT;
    assert.equal(canViewerSeeProject({ ownerUserId: 99, viewerUserId: 1, viewerUsername: ROOT }), true);
    assert.equal(canViewerSeeProject({ ownerUserId: 99, viewerUserId: 1, viewerUsername: 'Tianji.Chang' }), true);
  });

  test('没配 root 时谁都不是 root,不会误放行', () => {
    delete process.env.PRISM_ROOT_USERS;
    assert.equal(canViewerSeeProject({ ownerUserId: 99, viewerUserId: 1, viewerUsername: ROOT }), false);
  });

  test('匿名/未识别的连接看不到任何有主项目', () => {
    // 广播是按 socket 发的,拿不到身份时必须默认拒绝,不能默认放行。
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: null, viewerUsername: null }), false);
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: undefined, viewerUsername: undefined }), false);
  });
});
