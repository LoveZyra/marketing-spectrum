/**
 * br:改完项目权限,侧栏徽标必须实时更新(不必刷新页面)。
 *
 * 保存权限后 handleSidebarRefresh 会 GET /api/projects 拿到新数据,但只有
 * projectsHaveChanges 判定"变了"才会 setProjects。此前它只比 id/名字/路径/
 * 星标/会话,**漏了可见性四项**(isPublic / ownerUserId / sharedWithViewer /
 * sharedUserCount)—— 于是改完权限判"没变"→ 不更新 → 徽标停在旧值,必须整页刷新。
 * 这里逐项钉住:只改可见性也要被判为"变了"。
 */
import { describe, it, expect } from 'vitest';

import type { Project } from '../types/app';
import { projectsHaveChanges } from './useProjectsState';

const base = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  path: '/home/lqm',
  displayName: 'lqm',
  fullPath: '/home/lqm',
  isStarred: false,
  ownerUserId: null,
  isPublic: false,
  sharedWithViewer: false,
  sharedUserCount: 0,
  sessions: [],
  sessionMeta: { total: 0, hasMore: false },
  ...over,
} as Project);

describe('projectsHaveChanges 认得出可见性变化', () => {
  it('两份完全相同 → 无变化', () => {
    expect(projectsHaveChanges([base()], [base()])).toBe(false);
  });

  it('isPublic 变了 → 有变化(公共徽标要跟上)', () => {
    expect(projectsHaveChanges([base({ isPublic: false })], [base({ isPublic: true })])).toBe(true);
  });

  it('ownerUserId 变了 → 有变化(无主↔认领,个人徽标要跟上)', () => {
    expect(projectsHaveChanges([base({ ownerUserId: null })], [base({ ownerUserId: 2 })])).toBe(true);
  });

  it('sharedUserCount 变了 → 有变化(已共享·N 要跟上)', () => {
    expect(projectsHaveChanges([base({ sharedUserCount: 0 })], [base({ sharedUserCount: 3 })])).toBe(true);
  });

  it('sharedWithViewer 变了 → 有变化(接收方视角图标要跟上)', () => {
    expect(projectsHaveChanges([base({ sharedWithViewer: false })], [base({ sharedWithViewer: true })])).toBe(true);
  });

  it('公共 → 个人(isPublic true→false 且认领 owner)→ 有变化', () => {
    const wasPublic = base({ isPublic: true, ownerUserId: null });
    const nowPersonal = base({ isPublic: false, ownerUserId: 2 });
    expect(projectsHaveChanges([wasPublic], [nowPersonal])).toBe(true);
  });
});
