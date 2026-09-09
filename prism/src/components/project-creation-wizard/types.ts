export type WizardStep = 1 | 2;

export type FolderSuggestion = {
  name: string;
  path: string;
  type?: string;
};

export type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

export type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

/** 创建项目的权限三选:个人(默认)/ 公共(所有登录用户)/ 指定用户。 */
export type ProjectVisibilityChoice = 'personal' | 'public' | 'shared';

export type ShareableUser = {
  id: number;
  username: string;
};

export type CreateProjectPayload = {
  path: string;
  customName?: string;
  visibility?: ProjectVisibilityChoice;
  sharedUserIds?: number[];
  /** fh:从模板创建。空字符串/不传 = 空目录(原来的行为)。 */
  templateId?: string;
};

/** fh:服务器上的一个项目模板(`PRISM_PROJECT_TEMPLATES_DIR` 下的一棵目录树)。 */
export type ProjectTemplate = {
  id: string;
  name: string;
  description: string | null;
  fileCount: number;
  totalBytes: number;
};

export type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

export type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

export type WizardFormState = {
  workspacePath: string;
  visibility: ProjectVisibilityChoice;
  sharedUserIds: number[];
  /** 空串 = 不用模板。 */
  templateId: string;
};
