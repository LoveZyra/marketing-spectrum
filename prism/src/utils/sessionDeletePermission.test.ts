/**
 * 删除确认框里那枚红色「永久删除」按钮该不该画出来。
 *
 * 2026-09-15 用非 root 账号在测试环境实测:说明文字写着「只有项目负责人或
 * 管理员可以永久删除」,按钮照样是可点的红色主按钮,点下去撞 403。
 * 这里把客户端的判据钉成与服务端一致的三条。
 */
import { describe, it, expect } from 'vitest';

import { canArchiveOrDeleteProject, canPermanentlyDeleteSession } from './sessionDeletePermission';

describe('canPermanentlyDeleteSession', () => {
  it('root:全放行', () => {
    expect(canPermanentlyDeleteSession({ isRoot: true, viewerUserId: 4, projectOwnerUserId: 2 })).toBe(true);
  });

  it('项目负责人:放行', () => {
    expect(canPermanentlyDeleteSession({ viewerUserId: 4, projectOwnerUserId: 4 })).toBe(true);
    // id 一边是数字一边是字符串也要认(接口两种都出现过)
    expect(canPermanentlyDeleteSession({ viewerUserId: '4', projectOwnerUserId: 4 })).toBe(true);
  });

  it('不是负责人、也不是 root:不画那枚按钮 —— 这一条就是那个 bug', () => {
    expect(canPermanentlyDeleteSession({ viewerUserId: 4, projectOwnerUserId: 2 })).toBe(false);
    expect(canPermanentlyDeleteSession({ isRoot: false, viewerUserId: 4, projectOwnerUserId: 2 })).toBe(false);
  });

  it('无主项目:没有"负责人"这一档,看得见就能删(与服务端同口径)', () => {
    expect(canPermanentlyDeleteSession({ viewerUserId: 4, projectOwnerUserId: null })).toBe(true);
    expect(canPermanentlyDeleteSession({ viewerUserId: 4 })).toBe(true);
  });

  it('项目还没拿到手:按老行为画出来,交给服务端拦 —— 不因为加载时序把按钮藏错', () => {
    expect(canPermanentlyDeleteSession({ viewerUserId: 4, projectOwnerUserId: 2, projectKnown: false })).toBe(true);
  });

  it('拿不到当前用户 id:不认作负责人(别把按钮放给匿名)', () => {
    expect(canPermanentlyDeleteSession({ viewerUserId: null, projectOwnerUserId: 2 })).toBe(false);
    expect(canPermanentlyDeleteSession({ projectOwnerUserId: 2 })).toBe(false);
  });
});

/**
 * gn:项目的归档与永久删除收紧到同一条规则(服务端 canArchiveProject === canDeleteProject)。
 * 这里钉住"客户端这一份没有自己另走一套"。
 */
describe('canArchiveOrDeleteProject', () => {
  const cases: Array<[string, Parameters<typeof canArchiveOrDeleteProject>[0]]> = [
    ['root', { isRoot: true, viewerUserId: 4, projectOwnerUserId: 2 }],
    ['负责人', { viewerUserId: 4, projectOwnerUserId: 4 }],
    ['路人', { viewerUserId: 4, projectOwnerUserId: 2 }],
    ['无主项目', { viewerUserId: 4, projectOwnerUserId: null }],
    ['项目未知', { viewerUserId: 4, projectOwnerUserId: 2, projectKnown: false }],
  ];

  it('与会话那条逐例一致(共用一份实现,不许漂)', () => {
    for (const [label, input] of cases) {
      expect(canArchiveOrDeleteProject(input), label).toBe(canPermanentlyDeleteSession(input));
    }
  });

  it('路人归档别人的项目:不画按钮 —— 这一条就是 2026-09-15 实测那件事', () => {
    expect(canArchiveOrDeleteProject({ viewerUserId: 4, projectOwnerUserId: 2 })).toBe(false);
  });
});
