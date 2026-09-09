import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import type {
  CreateProjectPathResult,
  ProjectRepositoryRow,
  WorkspacePathValidationResult,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';
import { prepareProjectTemplate, writePreparedTemplate, type ApplyTemplateResult } from '@/modules/projects/services/project-template.service.js';

type CreateProjectInput = {
  projectPath: string;
  customName?: string | null;
  /** Account that will own the new project(公共/指定用户项目同样保留 owner 便于管理)。 */
  ownerUserId?: number | null;
  /** 'public' = 创建时选「公共」;null = 个人/指定用户(默认语义)。 */
  visibility?: 'public' | null;
  /** 创建时选「指定用户」的授权列表;写入 project_shares。 */
  sharedUserIds?: number[];
  /**
   * fh:从模板创建。模板就是服务器上一棵普通目录树,这里递归 copy 进去。
   * 不传就是原来的行为(空目录)。
   */
  templateId?: string | null;
};

type CreateProjectDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  ensureWorkspaceDirectory: (projectPath: string) => Promise<void>;
  persistProjectPath: (
    projectPath: string,
    customName: string | null,
    ownerUserId: number | null,
    visibility: 'public' | null,
  ) => CreateProjectPathResult;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
  setProjectShares: (projectId: string, userIds: number[], grantedBy: number | null) => void;
};

type ProjectApiView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  sessions: [];
  sessionMeta: {
    hasMore: false;
    total: 0;
  };
};

type CreateProjectServiceResult = {
  outcome: 'created' | 'reactivated_archived';
  project: ProjectApiView;
  /** fh:铺了模板时带上结果,让界面能如实说"这几个文件已存在,没动"。 */
  template?: ApplyTemplateResult;
};

const defaultDependencies: CreateProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureWorkspaceDirectory: async (projectPath: string): Promise<void> => {
    await fs.mkdir(projectPath, { recursive: true });
    const directoryStats = await fs.stat(projectPath);
    if (!directoryStats.isDirectory()) {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    }
  },
  persistProjectPath: (
    projectPath: string,
    customName: string | null,
    ownerUserId: number | null,
    visibility: 'public' | null,
  ): CreateProjectPathResult => projectsDb.createProjectPath(projectPath, customName, ownerUserId, visibility),
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectPath(projectPath),
  setProjectShares: (projectId: string, userIds: number[], grantedBy: number | null): void =>
    projectsDb.setProjectShares(projectId, userIds, grantedBy),
};

function resolveDisplayName(customName: string | null | undefined, projectPath: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  return path.basename(projectPath) || projectPath;
}

function mapProjectRowToApiView(projectRow: ProjectRepositoryRow): ProjectApiView {
  return {
    projectId: projectRow.project_id,
    path: projectRow.project_path,
    fullPath: projectRow.project_path,
    displayName: resolveDisplayName(projectRow.custom_project_name, projectRow.project_path),
    customName: projectRow.custom_project_name,
    isArchived: Boolean(projectRow.isArchived),
    isStarred: Boolean(projectRow.isStarred),
    sessions: [],
    sessionMeta: {
      hasMore: false,
      total: 0,
    },
  };
}

export async function createProject(
  input: CreateProjectInput,
  dependencies: CreateProjectDependencies = defaultDependencies,
): Promise<CreateProjectServiceResult> {
  const normalizedPath = normalizeProjectPath(input.projectPath || '');
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  /*
   * fh:**模板先验,后建。**
   *
   * 探针里抓到的真事:第一版把铺模板放在这个函数末尾,于是
   * `templateId: "../evil"` 走的是「建目录 → 项目行落库 → 才发现名字不合法 → 抛」,
   * 接口回 `success:false` 而项目**已经在库里**。连打五个非法请求,
   * 侧栏就多了五个幽灵项目 —— 用户被告知失败的东西,下次刷新自己冒出来。
   *
   * 所以校验(名字形状、模板存在、符号链接、大小上限)全部提到最前面:
   * 不合法就在什么都还没建的时候失败。比"失败了再回滚"可靠 —— 回滚本身也会失败,
   * 而且"复活归档路径"那种情形根本不该回滚。
   */
  const preparedTemplate = input.templateId
    ? await prepareProjectTemplate(input.templateId)
    : null;

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);
  await dependencies.ensureWorkspaceDirectory(resolvedProjectPath);

  const normalizedCustomName = resolveDisplayName(input.customName ?? null, resolvedProjectPath);
  const persistedProject = dependencies.persistProjectPath(
    resolvedProjectPath,
    normalizedCustomName,
    input.ownerUserId ?? null,
    input.visibility ?? null,
  );

  if (persistedProject.outcome === 'active_conflict') {
    throw new AppError('Project path already exists and is active', {
      code: 'PROJECT_ALREADY_EXISTS',
      statusCode: 409,
      details: `Project path already exists: ${resolvedProjectPath}`,
    });
  }

  const projectRow = persistedProject.project ?? dependencies.getProjectByPath(resolvedProjectPath);
  if (!projectRow) {
    throw new AppError('Failed to resolve project after creation', {
      code: 'PROJECT_CREATE_FAILED',
      statusCode: 500,
    });
  }

  // 指定用户授权:只在真正新建时写(复活归档路径不改权限,与 owner/visibility 同规)。
  const sharedUserIds = input.sharedUserIds ?? [];
  if (persistedProject.outcome === 'created' && sharedUserIds.length > 0) {
    dependencies.setProjectShares(projectRow.project_id, sharedUserIds, input.ownerUserId ?? null);
  }

  /*
   * fh:铺模板(校验已经在函数最前面做完了,这里只负责写)。
   *
   * ## 为什么"写"留在最后
   *
   * 写要发生在**目录建好、且这条项目记录确实落库之后**。放前面的话,
   * 后面任何一个 throw(路径不合法、路径已被别人占着)都会留下一棵铺好的树
   * 在一个不属于任何项目的目录里 —— 没人知道它存在,也没人会去清。
   *
   * ## 复活归档路径时也铺,但不覆盖
   *
   * `applyProjectTemplate` 对已存在的文件是**跳过**不是覆盖(COPYFILE_EXCL)。
   * 复活的目录里有真东西,拿模板盖上去就是数据丢失。
   *
   * ## 铺失败不回滚项目
   *
   * 项目已经建好了,模板只是锦上添花。失败时把错误抛给调用方,由路由决定
   * 是整个失败还是带着告警成功 —— 这里不擅自决定"要不要把刚建好的项目删掉"。
   */
  let templateResult: ApplyTemplateResult | undefined;
  if (preparedTemplate) {
    templateResult = await writePreparedTemplate(preparedTemplate, resolvedProjectPath);
  }

  // Archived rows intentionally remain archived when reused, as requested.
  return {
    outcome: persistedProject.outcome,
    project: mapProjectRowToApiView(projectRow),
    ...(templateResult ? { template: templateResult } : {}),
  };
}

/**
 * Sets `projects.custom_project_name` for the given `projectId` (or clears it when empty).
 */
export function updateProjectDisplayName(projectId: string, newDisplayName: unknown): void {
  const trimmed = typeof newDisplayName === 'string' ? newDisplayName.trim() : '';
  projectsDb.updateCustomProjectNameById(projectId, trimmed.length > 0 ? trimmed : null);
}
