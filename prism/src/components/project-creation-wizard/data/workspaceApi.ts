import { api, authenticatedFetch } from '../../../utils/api';
import type {
  BrowseFilesystemResponse,
  CreateFolderResponse,
  CreateProjectPayload,
  CreateProjectResponse,
  FolderSuggestion,
  ProjectTemplate,
  ShareableUser,
} from '../types';

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const browseFilesystemFolders = async (pathToBrowse: string) => {
  const endpoint = `/browse-filesystem?path=${encodeURIComponent(pathToBrowse)}`;
  const response = await api.get(endpoint);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string) => {
  const response = await api.createFolder(folderPath);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

/** 「指定用户」授权选择器的用户名录(不含自己;后端已过滤)。 */
export const fetchShareableUsers = async (): Promise<ShareableUser[]> => {
  const response = await authenticatedFetch('/api/projects/shareable-users');
  if (!response.ok) {
    throw new Error('Failed to load users');
  }
  const data = (await response.json()) as { data?: { users?: ShareableUser[] } };
  return data.data?.users ?? [];
};

/**
 * 要把 `revived` / `message` 一起带回去:路径命中一个已归档的项目时,服务端是把它还原
 * (并应用向导里选的可见性),不是新建;界面要据此告诉用户旧项目连同旧会话一起回来了。
 */
export const createProjectRequest = async (payload: CreateProjectPayload) => {
  const response = await api.createProject(payload);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    // 把服务端的错误码带出去,向导按码翻成界面语言(服务端原文是英文)。
    const error = new Error(resolveCreateProjectErrorMessage(data) || 'Failed to create project') as Error & { code?: string };
    const rawError = (data as { error?: unknown }).error;
    const code = rawError && typeof rawError === 'object' ? (rawError as { code?: unknown }).code : (data as { code?: unknown }).code;
    if (typeof code === 'string') error.code = code;
    throw error;
  }

  return {
    project: data.project,
    revived: data.revived === true,
    message: typeof data.message === 'string' ? data.message : null,
  };
};

/**
 * 拉可用模板。
 *
 * 失败时返回空数组而不是抛 —— 模板是锦上添花,取不到不该让「新建项目」整个打不开。
 * 界面上那一格自然消失,用户走空目录流程。
 */
export const fetchProjectTemplates = async (): Promise<ProjectTemplate[]> => {
  try {
    const response = await authenticatedFetch('/api/projects/templates');
    if (!response.ok) return [];
    const data = (await response.json()) as { data?: { templates?: ProjectTemplate[] } };
    return data.data?.templates ?? [];
  } catch {
    return [];
  }
};
