/**
 * Checkpoint REST API (ported from claude-web-ui 2.0).
 *
 * GET    /api/checkpoints?sessionId=&cwd=      list checkpoints
 * GET    /api/checkpoints/:id                  checkpoint metadata
 * GET    /api/checkpoints/:id/changes          changed files + diffs vs now
 * POST   /api/checkpoints/:id/restore          transactional full rollback
 *          409 { code: 'DIRECTORY_BUSY', sessionId }        another live run in this cwd
 *          409 { code: 'COMMITS_AFTER_CHECKPOINT', commits } unless ?force=1
 *          409 { code: 'CHECKPOINT_INCOMPLETE', reason }     unless ?force=1
 *          (force NEVER re-enables deletion of untracked files for an
 *           incomplete checkpoint — the service skips that phase and reports
 *           `skippedUntrackedCleanup` in the response)
 * POST   /api/checkpoints/:id/revert-file      revert one file ({ path })
 */

import express from 'express';

import {
  changedFilesSince,
  listCheckpoints,
  readCheckpoint,
  resolveRealPath,
  restoreCheckpoint,
  revertFile,
} from '../services/git-checkpoint.js';
import { isClaudeSDKSessionActive } from '../claude-sdk.js';
import { chatRunRegistry } from '../modules/websocket/services/chat-run-registry.service.js';
import { projectVisibilityInput, projectsDb, sessionMessagesDb, sessionsDb } from '../modules/database/index.js';
import { canViewerSeeProject, readRequestViewer } from '../shared/project-visibility.js';

const router = express.Router();

/**
 * 谁能看到 / 回滚一个 checkpoint。
 *
 * checkpoint 落在共享的 `~/.prism/checkpoints` 下,自己不带归属,所以归属要从
 * 它记录的会话或工作目录反查出来:
 *   1. `meta.sessionId` 是 provider 侧的会话 id —— 先换成 app 会话拿项目路径;
 *   2. 拿不到就退回 `meta.cwd`;
 *   3. 再由项目 owner 走与侧栏一致的那条判定。
 *
 * **路径没登记成项目时返回 false(仅 root)**,而不是沿用"owner 为空 = 公共"。
 * 那条规则是给项目列表用的,让人看见一个条目;这里放行的却是
 * `git reset --hard` 加删除未跟踪文件。同一个默认值放在这里就成了:任何人都能
 * 抹掉任何一个尚未登记目录里的未提交改动。
 */
function canViewerUseCheckpoint(req, meta) {
  const viewer = readRequestViewer(req);

  let projectPath = null;
  if (meta?.sessionId) {
    const session =
      sessionsDb.getSessionByProviderSessionId(meta.sessionId)
      ?? sessionsDb.getSessionById(meta.sessionId);
    projectPath = session?.project_path?.trim() ? session.project_path : null;
  }
  if (!projectPath && typeof meta?.cwd === 'string' && meta.cwd.trim()) {
    projectPath = meta.cwd;
  }

  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  if (!project) {
    // 未登记路径:只有 root。-1 是个不存在的 owner,借它复用同一条判定,
    // 免得在这里再手写一份 root 判断。
    return canViewerSeeProject({
      ownerUserId: -1,
      viewerUserId: viewer.userId,
      viewerUsername: viewer.username,
    });
  }

  return canViewerSeeProject({
    ...projectVisibilityInput(project, projectPath),
    viewerUserId: viewer.userId,
    viewerUsername: viewer.username,
  });
}

/**
 * Cross-session directory guard: find ANY live run (any session, any
 * provider) whose working directory resolves to the same real path as the
 * checkpoint's cwd. Uses the chat-run registry (the in-memory source of truth
 * for "is something running"), with cwds resolved from the sessions table by
 * the registry accessor. This complements — not replaces — the same-session
 * `isClaudeSDKSessionActive` check below.
 */
async function findActiveRunForCwd(cwd) {
  if (!cwd) return null;
  let activeRuns = [];
  try {
    activeRuns = chatRunRegistry.getActiveRunsInfo();
  } catch {
    return null;
  }
  if (activeRuns.length === 0) return null;
  const target = await resolveRealPath(cwd);
  for (const activeRun of activeRuns) {
    if (!activeRun.cwd) continue;
    if ((await resolveRealPath(activeRun.cwd)) === target) return activeRun;
  }
  return null;
}

function parseForceFlag(req) {
  const force = req.query?.force;
  return force === '1' || force === 'true';
}

router.get('/', async (req, res) => {
  try {
    const { sessionId, cwd } = req.query;
    // Checkpoints are stored under the provider-native session id; the client
    // only knows app session ids, so resolve through the DB when possible.
    let resolvedSessionId = typeof sessionId === 'string' && sessionId ? sessionId : undefined;
    if (resolvedSessionId) {
      try {
        const row = sessionsDb.getSessionById(resolvedSessionId);
        if (row?.provider_session_id) resolvedSessionId = row.provider_session_id;
      } catch { /* fall back to the raw id */ }
    }
    const checkpoints = await listCheckpoints({
      sessionId: resolvedSessionId,
      cwd: typeof cwd === 'string' && cwd ? cwd : undefined,
    });
    // Strip bulky fields for the list view.
    res.json({
      checkpoints: checkpoints
        .filter((meta) => canViewerUseCheckpoint(req, meta))
        .map(({ untrackedStored, untracked, ...meta }) => ({
        ...meta,
        untrackedCount: untracked?.length || 0,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const meta = await readCheckpoint(req.params.id);
    // 归属不符与不存在返回同一个 404:403 会确认"这个 id 是存在的"。
    if (!meta || !canViewerUseCheckpoint(req, meta)) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }
    res.json({ checkpoint: meta });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/changes', async (req, res) => {
  try {
    const meta = await readCheckpoint(req.params.id);
    // 归属不符与不存在返回同一个 404:403 会确认"这个 id 是存在的"。
    if (!meta || !canViewerUseCheckpoint(req, meta)) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }
    const changes = await changedFilesSince(req.params.id);
    res.json(changes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * dt:回滚/还原成功后往会话显示日志落一条 `files_reverted` 反向帧。
 *
 * 不落它,工作面板与磁盘永久漂移:文件被回滚删掉,产出列表还挂着,点开
 * 404。checkpoint meta 存的 sessionId 是 provider 原生 id,经 sessions 表
 * 反查应用侧会话 id;反查不到(极端)就跳过 —— 名帧是锦上添花,不拦回滚。
 * paths 只收**当时为新增**的文件(修改类回滚不影响"产出"语义)。
 */
/**
 * dv:进锁后复查"这棵树上没有回合在跑"。
 *
 * 与路由入口那次检查同源,但由 checkpoint 服务在**拿到 cwd 锁之后**调用 ——
 * 入口检查与真正的 `reset --hard` 之间隔着算改动清单、做安全快照等好几秒,
 * 聊天回合又不走 cwd 锁,那段窗口里发一条消息就能和回滚同时写同一棵树。
 * 返回 undefined 表示可以继续;返回对象则作为 409 的载荷。
 */
function makeBusyAssertion() {
  return async (meta) => {
    if (meta.sessionId && isClaudeSDKSessionActive(meta.sessionId)) {
      return {
        sessionId: meta.sessionId,
        error: 'This session started running while the rollback was preparing. Stop it and try again.',
      };
    }
    const activeRun = await findActiveRunForCwd(meta.cwd);
    if (activeRun) {
      return {
        sessionId: activeRun.sessionId,
        error: `Another session (${activeRun.sessionId}) started running in this directory while the rollback was preparing. Stop it and try again.`,
      };
    }
    return undefined;
  };
}

function appendFilesRevertedFrame(meta, relPaths) {
  try {
    if (!relPaths || relPaths.length === 0) return;
    const providerSessionId = typeof meta?.sessionId === 'string' ? meta.sessionId : '';
    if (!providerSessionId) return;
    const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
    if (!row?.session_id) return;
    sessionMessagesDb.append(row.session_id, {
      id: `files_reverted_${meta.id}_${Date.now()}`,
      sessionId: row.session_id,
      timestamp: new Date().toISOString(),
      provider: 'claude',
      kind: 'files_reverted',
      checkpointId: meta.id,
      cwd: meta.cwd || null,
      paths: relPaths,
    });
  } catch (error) {
    console.warn('[Checkpoint] files_reverted frame append failed:', error?.message || error);
  }
}

router.post('/:id/restore', async (req, res) => {
  try {
    const meta = await readCheckpoint(req.params.id);
    // 归属不符与不存在返回同一个 404:403 会确认"这个 id 是存在的"。
    if (!meta || !canViewerUseCheckpoint(req, meta)) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }

    // A running turn writing to the same tree must not race a rollback.
    if (meta.sessionId && isClaudeSDKSessionActive(meta.sessionId)) {
      return res.status(409).json({
        code: 'DIRECTORY_BUSY',
        sessionId: meta.sessionId,
        error: 'This session is still running. Stop the current turn before rolling back.',
      });
    }

    // Nor may a rollback race a live run from ANY other session in the same
    // directory (force does not bypass this — stop the run instead).
    const activeRun = await findActiveRunForCwd(meta.cwd);
    if (activeRun) {
      return res.status(409).json({
        code: 'DIRECTORY_BUSY',
        sessionId: activeRun.sessionId,
        error: `Another session (${activeRun.sessionId}) is actively running in this directory. Stop it before rolling back.`,
      });
    }

    // 回滚前先算"即将被撤掉的新增文件"—— 回滚之后就无从对比了。
    let revertedNewPaths = [];
    try {
      const changes = await changedFilesSince(req.params.id);
      revertedNewPaths = (changes.files || [])
        .filter((file) => file.status === 'added' || file.untracked)
        .map((file) => file.path)
        .filter(Boolean);
    } catch { /* 算不出就不落反向帧,回滚照常 */ }

    const result = await restoreCheckpoint(req.params.id, { force: parseForceFlag(req), assertNotBusy: makeBusyAssertion() });
    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }
    appendFilesRevertedFrame(meta, revertedNewPaths);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/revert-file', async (req, res) => {
  try {
    const relPath = typeof req.body?.path === 'string' ? req.body.path : '';
    if (!relPath) return res.status(400).json({ error: 'path is required' });

    const meta = await readCheckpoint(req.params.id);
    // 归属不符与不存在返回同一个 404:403 会确认"这个 id 是存在的"。
    if (!meta || !canViewerUseCheckpoint(req, meta)) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }
    if (meta.sessionId && isClaudeSDKSessionActive(meta.sessionId)) {
      return res.status(409).json({
        code: 'DIRECTORY_BUSY',
        sessionId: meta.sessionId,
        error: 'This session is still running. Stop the current turn before reverting files.',
      });
    }

    const activeRun = await findActiveRunForCwd(meta.cwd);
    if (activeRun) {
      return res.status(409).json({
        code: 'DIRECTORY_BUSY',
        sessionId: activeRun.sessionId,
        error: `Another session (${activeRun.sessionId}) is actively running in this directory. Stop it before reverting files.`,
      });
    }

    const result = await revertFile(req.params.id, relPath, { assertNotBusy: makeBusyAssertion() });
    if (!result.ok) return res.status(422).json(result);
    // 单文件还原:该文件当时若非新增,collectWorkFrames 里本没有它的产出帧,
    // 反向帧就是空操作 —— 无需区分,统一落。
    appendFilesRevertedFrame(meta, [relPath]);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
