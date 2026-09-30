/**
 * hl(动态 P2-4):侧栏对 `project_upserted` / `project_removed` 的处理 —— 已知项目就地合并
 * 元数据且**保留会话列表**,陌生项目交给调用方重拉(返回 null),移除时引用稳定。
 */
import { describe, expect, it } from 'vitest';

import type { Project } from '../types/app';

import { markSelectedProjectRemoved, mergeProjectUpsert, removeProjectById, type ProjectUpsertedEvent } from './useProjectsState';

const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  path: '/ws/p1',
  fullPath: '/ws/p1',
  displayName: 'p1',
  isStarred: false,
  ownerUserId: 1,
  isPublic: false,
  sharedWithViewer: false,
  sharedUserCount: 0,
  sessions: [{ id: 's1', summary: 'keep me' }],
  sessionMeta: { hasMore: true, total: 7 },
  ...over,
});

const upsert = (over: Partial<ProjectUpsertedEvent['project']> = {}): ProjectUpsertedEvent => ({
  kind: 'project_upserted',
  projectId: 'p1',
  project: {
    projectId: 'p1', path: '/ws/p1', fullPath: '/ws/p1', displayName: '新名字', isStarred: true,
    ownerUserId: 2, isPublic: true, sharedWithViewer: false, sharedUserCount: 3, ...over,
  },
});

describe('mergeProjectUpsert', () => {
  it('已知项目:换元数据,保留会话与分页', () => {
    const merged = mergeProjectUpsert([project()], upsert());
    expect(merged).not.toBeNull();
    const [p] = merged!;
    expect(p.displayName).toBe('新名字');
    expect(p.ownerUserId).toBe(2);
    expect(p.isPublic).toBe(true);
    expect(p.sharedUserCount).toBe(3);
    expect(p.isStarred).toBe(true);
    expect(p.sessions).toEqual([{ id: 's1', summary: 'keep me' }]);
    expect(p.sessionMeta).toEqual({ hasMore: true, total: 7 });
  });

  it('陌生项目返回 null(调用方重拉);内容没变返回原数组引用', () => {
    expect(mergeProjectUpsert([project({ projectId: 'other' })], upsert())).toBeNull();
    const list = [project({ displayName: '新名字', isStarred: true, ownerUserId: 2, isPublic: true, sharedUserCount: 3 })];
    expect(mergeProjectUpsert(list, upsert())).toBe(list);
  });

  it('转移属主后 ownerUserId 为 null 也要落下来(不能被 ?? 吞成旧值)', () => {
    const [p] = mergeProjectUpsert([project()], upsert({ ownerUserId: null }))!;
    expect(p.ownerUserId).toBeNull();
  });
});

describe('removeProjectById', () => {
  it('拿掉命中的;没命中返回原引用', () => {
    const list = [project(), project({ projectId: 'p2' })];
    expect(removeProjectById(list, 'p2').map((p) => p.projectId)).toEqual(['p1']);
    expect(removeProjectById(list, 'nope')).toBe(list);
  });
});

describe('hl 复核 P3-8 markSelectedProjectRemoved', () => {
  it('正在看的项目被移除:保留(基线置 null 把对话区切掉),只打 removedFromView', () => {
    const selected = project();
    const next = markSelectedProjectRemoved(selected, 'p1');
    expect(next).not.toBeNull();
    expect(next?.projectId).toBe('p1');
    expect(next?.removedFromView).toBe(true);
  });
  it('移除的是别的项目 / 已经打过标 / 没有选中:原样返回', () => {
    const selected = project();
    expect(markSelectedProjectRemoved(selected, 'p2')).toBe(selected);
    const marked = { ...selected, removedFromView: true };
    expect(markSelectedProjectRemoved(marked, 'p1')).toBe(marked);
    expect(markSelectedProjectRemoved(null, 'p1')).toBeNull();
  });
});
