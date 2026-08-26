import assert from 'node:assert/strict';
import path from 'node:path';

import { afterEach, describe, test } from 'vitest';

import { canViewerSeeProject, isPublicWorkspacePath } from '../project-visibility.js';

const ROOT = 'tianji.chang';
const originalRootUsers = process.env.PRISM_ROOT_USERS;
const originalPublic = process.env.PRISM_PUBLIC_WORKSPACE;

afterEach(() => {
  if (originalRootUsers === undefined) delete process.env.PRISM_ROOT_USERS;
  else process.env.PRISM_ROOT_USERS = originalRootUsers;
  if (originalPublic === undefined) delete process.env.PRISM_PUBLIC_WORKSPACE;
  else process.env.PRISM_PUBLIC_WORKSPACE = originalPublic;
});

const PUB = path.resolve('/srv/public-workspace');

describe('项目可见性(列表与实时广播共用)', () => {
  test('有主项目:本人可见,别人不可见 —— 这就是串台的那一条', () => {
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: 7, viewerUsername: 'bob' }), true);
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: 8, viewerUsername: 'carol' }), false);
  });

  test('id 类型不一致也要认得出是同一个人', () => {
    assert.equal(canViewerSeeProject({ ownerUserId: '7', viewerUserId: 7, viewerUsername: 'bob' }), true);
  });

  test('root 看得到别人的项目(有主、无主都看得到)', () => {
    process.env.PRISM_ROOT_USERS = ROOT;
    assert.equal(canViewerSeeProject({ ownerUserId: 99, viewerUserId: 1, viewerUsername: ROOT }), true);
    assert.equal(canViewerSeeProject({ ownerUserId: 99, viewerUserId: 1, viewerUsername: 'Tianji.Chang' }), true);
    // 无主、且不在公共目录 —— 对普通人不可见,但 root 照样看得到。
    assert.equal(
      canViewerSeeProject({ ownerUserId: null, viewerUserId: 1, viewerUsername: ROOT, projectPath: '/srv/random/proj' }),
      true,
    );
  });

  test('没配 root 时谁都不是 root,不会误放行', () => {
    delete process.env.PRISM_ROOT_USERS;
    assert.equal(canViewerSeeProject({ ownerUserId: 99, viewerUserId: 1, viewerUsername: ROOT }), false);
  });

  test('匿名/未识别的连接看不到任何有主项目', () => {
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: null, viewerUsername: null }), false);
    assert.equal(canViewerSeeProject({ ownerUserId: 7, viewerUserId: undefined, viewerUsername: undefined }), false);
  });

  /**
   * 创建项目的权限三选(2026-08-18):visibility='public' 全员可见;
   * sharedUserIds(project_shares)逐用户授权。
   */
  describe('显式公共与指定用户授权', () => {
    test("visibility='public':陌生人也可见,不依赖路径与公共目录", () => {
      delete process.env.PRISM_PUBLIC_WORKSPACE;
      assert.equal(
        canViewerSeeProject({ ownerUserId: 7, viewerUserId: 8, viewerUsername: 'carol', projectPath: '/anywhere', visibility: 'public' }),
        true,
      );
    });

    test('指定用户:在授权名单里可见,不在则不可见', () => {
      const base = { ownerUserId: 7, projectPath: '/srv/x', sharedUserIds: [3, 5] };
      assert.equal(canViewerSeeProject({ ...base, viewerUserId: 5, viewerUsername: 'eve' }), true);
      assert.equal(canViewerSeeProject({ ...base, viewerUserId: 8, viewerUsername: 'mallory' }), false);
    });

    test('授权名单的 id 类型不一致也认得出(3 vs "3")', () => {
      assert.equal(
        canViewerSeeProject({ ownerUserId: 7, viewerUserId: '3', viewerUsername: 'x', sharedUserIds: [3] }),
        true,
      );
    });

    test('授权不越过无主规则:无主项目即便带名单,仍按公共目录口径走', () => {
      delete process.env.PRISM_PUBLIC_WORKSPACE;
      // 无主 + 不在公共目录:即便名单里有 viewer,也不可见 —— 无主项目没有"授权人",
      // 名单不该有来源;这一条钉死解析顺序,防止未来把顺序改错。
      assert.equal(
        canViewerSeeProject({ ownerUserId: null, viewerUserId: 5, viewerUsername: 'x', projectPath: '/srv/o', sharedUserIds: [5] }),
        false,
      );
    });
  });

  /**
   * 新口径(2026-08-14)的核心:无主项目**不再默认公开**。
   * 只有落在 PRISM_PUBLIC_WORKSPACE 之下的无主项目才对所有人可见,其余仅 root。
   * 这一条堵的是"任何被扫描进来、还没认领的目录自动对全员可见"的默认漏。
   */
  describe('无主项目的公共目录口径', () => {
    test('配了公共目录:目录下的无主项目所有人可见,目录外的只有 root', () => {
      process.env.PRISM_PUBLIC_WORKSPACE = PUB;
      delete process.env.PRISM_ROOT_USERS;

      // 公共目录下 —— 对普通人可见
      assert.equal(
        canViewerSeeProject({ ownerUserId: null, viewerUserId: 5, viewerUsername: 'x', projectPath: path.join(PUB, 'shared-notes') }),
        true,
      );
      // 公共目录本身
      assert.equal(
        canViewerSeeProject({ ownerUserId: null, viewerUserId: 5, viewerUsername: 'x', projectPath: PUB }),
        true,
      );
      // 目录外的无主项目 —— 普通人看不到
      assert.equal(
        canViewerSeeProject({ ownerUserId: null, viewerUserId: 5, viewerUsername: 'x', projectPath: '/srv/other/proj' }),
        false,
      );
    });

    test('没配公共目录:所有无主项目对非 root 一律不可见', () => {
      delete process.env.PRISM_PUBLIC_WORKSPACE;
      delete process.env.PRISM_ROOT_USERS;
      assert.equal(
        canViewerSeeProject({ ownerUserId: null, viewerUserId: 5, viewerUsername: 'x', projectPath: PUB }),
        false,
      );
      // 连路径都没传时也当作"不在公共目录",默认拒绝。
      assert.equal(canViewerSeeProject({ ownerUserId: null, viewerUserId: 5, viewerUsername: 'x' }), false);
    });

    test('前缀不能被相邻目录名骗过 —— /srv/public-workspace-evil 不算公共', () => {
      process.env.PRISM_PUBLIC_WORKSPACE = PUB;
      assert.equal(isPublicWorkspacePath(`${PUB}-evil/proj`), false);
      assert.equal(isPublicWorkspacePath(path.join(PUB, 'a')), true);
      assert.equal(isPublicWorkspacePath(PUB), true);
    });

    test('公共目录未配置时 isPublicWorkspacePath 恒 false', () => {
      delete process.env.PRISM_PUBLIC_WORKSPACE;
      assert.equal(isPublicWorkspacePath('/anything'), false);
      assert.equal(isPublicWorkspacePath(PUB), false);
    });

    /**
     * 侧栏"公共"徽标的口径 —— 后端 isPublic 字段用的就是这条:
     * 无主 **且** 落在公共目录下。钉死"无主 ≠ 公共",正是 jovyan / prism
     * 在没配公共目录时被误标"公共"的那个 bug。
     */
    test('公共徽标口径:无主且在公共目录下才算公共(有主/目录外/未配置都不是)', () => {
      const isPublicBadge = (ownerUserId, projectPath) =>
        (ownerUserId ?? null) === null && isPublicWorkspacePath(projectPath);

      // 没配公共目录:无主的 jovyan / prism 也不是"公共"(这就是用户报的现象)
      delete process.env.PRISM_PUBLIC_WORKSPACE;
      assert.equal(isPublicBadge(null, '/home/jovyan'), false);
      assert.equal(isPublicBadge(null, '/home/jovyan/prism'), false);

      // 配了公共目录后
      process.env.PRISM_PUBLIC_WORKSPACE = PUB;
      assert.equal(isPublicBadge(null, path.join(PUB, 'shared')), true); // 无主 + 目录下 = 公共
      assert.equal(isPublicBadge(null, '/home/jovyan'), false); // 无主但目录外 = 不是公共(仅 root)
      assert.equal(isPublicBadge(42, path.join(PUB, 'shared')), false); // 有主即便在目录下也不是公共
    });
  });

  /**
   * bq:「公共 → 个人」改不回的根因与修复不变量。
   *
   * 无主项目落在公共目录下 = 对所有人可见(= 公共)。此前选「个人」只清 visibility 列、
   * 不认领归属,项目仍无主 → 仍在公共目录下 → 还是所有人可见,于是"改回个人还是公共"。
   * 修复:选「个人 / 共享」时把无主项目认领给操作者。这里锁住的正是"一旦有主,
   * 公共目录下的无主口径就不再适用、他人立即看不见"这个不变量。
   */
  describe('bq 权限互斥:个人必须让项目有主', () => {
    test('无主 + 公共目录 = 所有人可见(改之前的"公共"态)', () => {
      process.env.PRISM_PUBLIC_WORKSPACE = PUB;
      assert.equal(
        canViewerSeeProject({ ownerUserId: null, viewerUserId: 8, viewerUsername: 'carol', projectPath: path.join(PUB, 'lqm'), visibility: null }),
        true,
      );
    });

    test('认领归属后(个人态):owner 可见、他人不可见 —— 这才是"个人"生效', () => {
      process.env.PRISM_PUBLIC_WORKSPACE = PUB;
      const proj = { projectPath: path.join(PUB, 'lqm'), visibility: null, sharedUserIds: [] };
      // owner 认领给 id=2
      assert.equal(canViewerSeeProject({ ...proj, ownerUserId: 2, viewerUserId: 2, viewerUsername: 'demo' }), true);
      assert.equal(canViewerSeeProject({ ...proj, ownerUserId: 2, viewerUserId: 8, viewerUsername: 'carol' }), false);
    });

    test('公共 → 个人 → 公共 → 个人:每一步都唯一生效', () => {
      process.env.PRISM_PUBLIC_WORKSPACE = PUB;
      const p2 = path.join(PUB, 'lqm');
      const other = { viewerUserId: 8, viewerUsername: 'carol', projectPath: p2 };
      // 公共(visibility=public,owner 认领给 2)
      assert.equal(canViewerSeeProject({ ...other, ownerUserId: 2, visibility: 'public', sharedUserIds: [] }), true);
      // 个人(visibility=null,owner=2)
      assert.equal(canViewerSeeProject({ ...other, ownerUserId: 2, visibility: null, sharedUserIds: [] }), false);
      // 共享给 8
      assert.equal(canViewerSeeProject({ ...other, ownerUserId: 2, visibility: null, sharedUserIds: [8] }), true);
      // 再回个人:8 立刻看不见
      assert.equal(canViewerSeeProject({ ...other, ownerUserId: 2, visibility: null, sharedUserIds: [] }), false);
    });
  });
});
