import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  CheckCircle2,
  FileCode2,
  FileText,
  FileUp,
  FolderUp,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../lib/utils';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Shimmer,
  useToast,
} from '../../../shared/view/ui';
import { useProviderSkills } from '../hooks/useProviderSkills';
import type {
  ProviderSkill,
  ProviderSkillCreateEntryPayload,
  SkillsProject,
  SkillsProvider,
  SkillsScope,
} from '../types';

type ProviderSkillsProps = {
  selectedProvider: SkillsProvider;
  currentProjects: SkillsProject[];
};

type QueuedSkillSourceFile = {
  file: File;
  relativePath: string;
};

type QueuedSkillFile = {
  id: string;
  name: string;
  size: number;
  kind: 'markdown' | 'folder';
  skillFile: File;
  files: QueuedSkillSourceFile[];
};

const MAX_SKILL_FOLDER_FILES = 500;
const MAX_SKILL_FOLDER_BYTES = 30 * 1024 * 1024;

// These two maps used to be keyed by provider, and `PROVIDER_SKILL_PATHS`
// carried an `Exclude<SkillsProvider, 'opencode'>` key because OpenCode had no
// on-disk skills directory to name. One provider is left, so both are constants.
const PROVIDER_NAME = 'Claude';
const PROVIDER_SKILL_PATH = '~/.claude/skills/<skill-name>/SKILL.md';

const SCOPE_LABELS: Record<SkillsScope, string> = {
  user: 'User',
  plugin: 'Plugin',
  project: 'Project',
};

const SCOPE_BADGE_CLASSES: Record<SkillsScope, string> = {
  user: 'border-primary/[0.32] bg-primary/[0.08] text-foreground dark:text-primary',
  plugin: 'border-primary/[0.32] bg-primary/[0.08] text-foreground dark:text-primary',
  project: 'border-border bg-muted text-muted-foreground',
};

const SCOPE_ORDER: SkillsScope[] = ['user', 'plugin', 'project'];

const groupSkillsByScope = (skills: ProviderSkill[]): Array<{ scope: SkillsScope; skills: ProviderSkill[] }> => (
  SCOPE_ORDER
    .map((scope) => ({ scope, skills: skills.filter((skill) => skill.scope === scope) }))
    .filter((group) => group.skills.length > 0)
);

const formatFileSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

const getBrowserRelativePath = (file: File): string => {
  const fileWithRelativePath = file as File & {
    path?: string;
    webkitRelativePath?: string;
  };
  return (
    fileWithRelativePath.webkitRelativePath
    || fileWithRelativePath.path
    || file.name
  )
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const getParentPath = (filePath: string): string => {
  const separatorIndex = filePath.lastIndexOf('/');
  return separatorIndex >= 0 ? filePath.slice(0, separatorIndex) : '';
};

const getBaseName = (filePath: string): string => {
  const segments = filePath.split('/').filter(Boolean);
  return segments.at(-1) || 'skill';
};

const readFileAsBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const result = typeof reader.result === 'string' ? reader.result : '';
    const separatorIndex = result.indexOf(',');
    resolve(separatorIndex >= 0 ? result.slice(separatorIndex + 1) : result);
  };
  reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
  reader.readAsDataURL(file);
});

const buildQueuedSkillFolders = (
  selectedFiles: File[],
  messages?: { sizeLimit?: string; noSkillMd?: string },
): QueuedSkillFile[] => {
  if (selectedFiles.length > MAX_SKILL_FOLDER_FILES) {
    throw new Error(`A skill folder can contain up to ${MAX_SKILL_FOLDER_FILES} files.`);
  }

  const totalSize = selectedFiles.reduce((size, file) => size + file.size, 0);
  if (totalSize > MAX_SKILL_FOLDER_BYTES) {
    throw new Error(messages?.sizeLimit || 'Selected skill folders must be smaller than 30 MB in total.');
  }

  const files = selectedFiles.map((file) => ({
    file,
    relativePath: getBrowserRelativePath(file),
  }));
  const skillRoots = files
    .filter(({ relativePath }) => getBaseName(relativePath).toLowerCase() === 'skill.md')
    .map(({ relativePath }) => getParentPath(relativePath))
    .sort((left, right) => right.length - left.length);

  if (skillRoots.length === 0) {
    throw new Error(messages?.noSkillMd || 'The selected folder does not contain a SKILL.md file.');
  }

  return skillRoots.map((skillRoot) => {
    const skillFiles = files.filter(({ relativePath }) => {
      const owningRoot = skillRoots.find((candidateRoot) => {
        const normalizedRelativePath = relativePath.toLowerCase();
        const normalizedSkillPath = `${candidateRoot}/skill.md`.toLowerCase();
        return normalizedRelativePath === normalizedSkillPath
          || relativePath.startsWith(`${candidateRoot}/`);
      });
      return owningRoot === skillRoot;
    });
    const skillSourceFile = skillFiles.find(
      ({ relativePath }) => (
        relativePath.toLowerCase() === `${skillRoot}/skill.md`.toLowerCase()
      ),
    );
    if (!skillSourceFile) {
      throw new Error(`Could not read SKILL.md from ${getBaseName(skillRoot)}.`);
    }

    return {
      id: `folder:${skillRoot}:${skillFiles.map(({ file }) => file.lastModified).join(':')}`,
      name: getBaseName(skillRoot),
      size: skillFiles.reduce((size, { file }) => size + file.size, 0),
      kind: 'folder' as const,
      skillFile: skillSourceFile.file,
      files: skillFiles.map(({ file, relativePath }) => ({
        file,
        relativePath: skillRoot ? relativePath.slice(skillRoot.length + 1) : relativePath,
      })),
    };
  });
};

export default function ProviderSkills({ selectedProvider, currentProjects }: ProviderSkillsProps) {
  const { t } = useTranslation('settings');
  const {
    skills,
    isLoading,
    isLoadingProjectScopes,
    loadError,
    saveStatus,
    addSkills,
    removeSkill,
    refreshSkills,
  } = useProviderSkills({ selectedProvider, currentProjects });
  const { toast } = useToast();
  /**
   * F13:卸载确认。装错一个技能之前只能登服务器删目录 —— 现在界面上有入口了,
   * 但删目录是不可逆的,所以要**二次确认**,而且确认里写清删的是哪个目录。
   */
  const [pendingRemoval, setPendingRemoval] = useState<ProviderSkill | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const confirmRemoval = useCallback(async () => {
    const target = pendingRemoval;
    if (!target?.directoryName || isRemoving) return;
    setIsRemoving(true);
    try {
      await removeSkill(target.directoryName);
      toast({
        message: t('skills.removeDone', { name: target.name, defaultValue: `已卸载「${target.name}」` }),
        variant: 'success',
      });
      setPendingRemoval(null);
    } catch (error) {
      toast({
        message: error instanceof Error ? error.message : t('skills.removeFailed', { defaultValue: '卸载失败,请重试。' }),
        variant: 'error',
      });
    } finally {
      setIsRemoving(false);
    }
  }, [pendingRemoval, isRemoving, removeSkill, toast, t]);
  const [queuedFiles, setQueuedFiles] = useState<QueuedSkillFile[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [justInstalled, setJustInstalled] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [showInstallPath, setShowInstallPath] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const providerName = PROVIDER_NAME;
  const providerPath = PROVIDER_SKILL_PATH;

  useEffect(() => {
    setQueuedFiles([]);
    setSubmitError(null);
    setIsSubmitting(false);
    setSearchQuery('');
    setIsAddDialogOpen(false);
    setShowInstallPath(false);
    setJustInstalled(false);
  }, [selectedProvider]);

  const setFolderInputRef = useCallback((node: HTMLInputElement | null) => {
    folderInputRef.current = node;
    if (!node) {
      return;
    }

    node.setAttribute('webkitdirectory', '');
    node.setAttribute('directory', '');
  }, []);

  const filteredSkills = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return skills;
    }

    return skills.filter((skill) => (
      [
        skill.command,
        skill.name,
        skill.description,
        skill.scope,
        skill.pluginName,
        skill.projectDisplayName,
        skill.sourcePath,
      ]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
    ));
  }, [searchQuery, skills]);

  const groupedSkills = useMemo(() => groupSkillsByScope(filteredSkills), [filteredSkills]);

  const queueSkillFolders = useCallback((selectedFiles: File[]) => {
    const queuedFolders = buildQueuedSkillFolders(selectedFiles, {
      sizeLimit: t('skills.sizeLimit'),
      noSkillMd: t('skills.noSkillMd'),
    });
    setQueuedFiles((previous) => {
      const nextMap = new Map(previous.map((file) => [file.id, file]));
      queuedFolders.forEach((folder) => nextMap.set(folder.id, folder));
      return [...nextMap.values()].slice(0, 20);
    });
  }, [t]);

  const handleDrop = useCallback((files: File[]) => {
    const includesDirectory = files.some((file) => getBrowserRelativePath(file).includes('/'));
    if (includesDirectory) {
      try {
        queueSkillFolders(files);
        setSubmitError(null);
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : t('skills.readFailed'));
      }
      return;
    }

    const acceptedFiles = files
      .filter((file) => file.name.toLowerCase().endsWith('.md'))
      .slice(0, 20);

    if (acceptedFiles.length === 0) {
      setSubmitError(t('skills.dropHint2'));
      return;
    }

    setQueuedFiles((previous) => {
      const nextMap = new Map(previous.map((file) => [file.id, file]));
      acceptedFiles.forEach((file) => {
        const id = `${file.name}:${file.size}:${file.lastModified}`;
        nextMap.set(id, {
          id,
          name: file.name,
          size: file.size,
          kind: 'markdown',
          skillFile: file,
          files: [{ file, relativePath: 'SKILL.md' }],
        });
      });

      return [...nextMap.values()].slice(0, 20);
    });
    setSubmitError(null);
  }, [queueSkillFolders, t]);

  const handleFolderSelection = useCallback((selectedFiles: File[]) => {
    if (selectedFiles.length === 0) {
      return;
    }

    try {
      queueSkillFolders(selectedFiles);
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to read skill folder');
    }
  }, [queueSkillFolders]);

  const { getRootProps, isDragActive } = useDropzone({
    maxFiles: MAX_SKILL_FOLDER_FILES,
    noClick: true,
    noKeyboard: true,
    onDrop: handleDrop,
  });

  const handleUploadInstall = useCallback(async () => {
    if (queuedFiles.length === 0) {
      setSubmitError(t('skills.addFilesFirst'));
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const entries = await Promise.all<ProviderSkillCreateEntryPayload>(queuedFiles.map(async (queuedFile) => ({
        fileName: queuedFile.kind === 'folder' ? `${queuedFile.name}.md` : queuedFile.name,
        directoryName: queuedFile.kind === 'folder' ? queuedFile.name : undefined,
        content: await queuedFile.skillFile.text(),
        files: queuedFile.kind === 'folder'
          ? await Promise.all(
            queuedFile.files
              .filter(({ relativePath }) => relativePath.toLowerCase() !== 'skill.md')
              .map(async ({ file, relativePath }) => ({
                relativePath,
                content: await readFileAsBase64(file),
                encoding: 'base64' as const,
              })),
          )
          : undefined,
      })));
      await addSkills({ entries });
      setQueuedFiles([]);
      setJustInstalled(true);
      setIsAddDialogOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to import skills');
    } finally {
      setIsSubmitting(false);
    }
  }, [addSkills, queuedFiles, t]);

  const handleAddDialogOpenChange = useCallback((open: boolean) => {
    if (open) {
      setSubmitError(null);
      setShowInstallPath(false);
      setJustInstalled(false);
      setIsAddDialogOpen(true);
      return;
    }

    setQueuedFiles([]);
    setSubmitError(null);
    setShowInstallPath(false);
    setJustInstalled(false);
    setIsAddDialogOpen(false);
  }, []);

  const uploadPanel = (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={cn(
          'rounded-lg border border-dashed p-4 transition-colors sm:p-5',
          isDragActive
            ? 'border-primary bg-card'
            : 'border-border bg-card hover:border-border-strong',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,text/markdown"
          multiple
          className="hidden"
          onChange={(event) => {
            handleDrop(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <input
          ref={setFolderInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            handleFolderSelection(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <div className="flex flex-col items-center justify-center gap-3 py-4 text-center">
          <FileUp className="h-7 w-7 text-muted-foreground" strokeWidth={1.5} />
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">{t('skills.dropTitle')}</div>
            <div className="text-sm text-muted-foreground">
              {t('skills.dropSubtitle')}
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="w-full sm:w-auto"
            >
              <FileUp className="h-4 w-4" />
              {t('skills.chooseFiles')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => folderInputRef.current?.click()}
              className="w-full sm:w-auto"
            >
              <FolderUp className="h-4 w-4" />
              {t('skills.chooseFolder')}
            </Button>
          </div>
        </div>
      </div>

      {queuedFiles.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">{t('skills.readyToInstall')}</div>
          <div className="grid gap-2">
            {queuedFiles.map((queuedFile) => (
              <div
                key={queuedFile.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  {queuedFile.kind === 'folder' ? <FolderUp className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">{queuedFile.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {queuedFile.kind === 'folder'
                      ? `${queuedFile.files.length} files`
                      : t('skills.markdownFile')}
                    {' · '}
                    {formatFileSize(queuedFile.size)}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 flex-shrink-0 p-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${queuedFile.name}`}
                  onClick={() => {
                    setQueuedFiles((previous) => previous.filter((file) => file.id !== queuedFile.id));
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {providerPath && (
        <div className="space-y-2">
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowInstallPath((current) => !current)}
          >
            {showInstallPath ? t('skills.hideInstallPath') : t('skills.showInstallPath')}
          </button>
          {showInstallPath && (
            <div className="rounded-lg border border-border bg-card p-3">
              <code className="block whitespace-normal break-all text-xs text-foreground">{providerPath}</code>
            </div>
          )}
        </div>
      )}

    </div>
  );

  return (
    <div className="min-w-0 space-y-4 overflow-x-hidden">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
          <FileCode2 className="h-4 w-4" strokeWidth={1.7} />
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-medium text-foreground">{t('tabs.skills', { defaultValue: 'Skills' })}</h3>
          <p className="text-sm text-muted-foreground">
            Manage {providerName} skills from local files, complete folders, and project-aware locations.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('skills.searchPlaceholder')}
              aria-label={t('skills.searchAria')}
              className="h-9 w-full pl-9 pr-9"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label={t('skills.clearSearch')}
                className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            className="w-full sm:w-auto"
            onClick={() => handleAddDialogOpenChange(true)}
          >
            <Plus className="h-4 w-4" />
            {t('skills.addSkill')}
          </Button>
          <Button
            onClick={() => void refreshSkills({ force: true })}
            variant="outline"
            size="sm"
            className="w-full sm:w-auto"
            disabled={isLoading || isLoadingProjectScopes}
          >
            <RefreshCw className={cn('h-4 w-4', (isLoading || isLoadingProjectScopes) && 'text-primary')} />
            {t('skills.refresh')}
          </Button>
        </div>
        {isLoadingProjectScopes && (
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Shimmer>{t('skills.scanning')}</Shimmer>
          </div>
        )}
      </div>

      <Dialog open={isAddDialogOpen} onOpenChange={handleAddDialogOpenChange}>
        <DialogContent
          wrapperClassName="z-[10000]"
          className="flex h-[calc(100vh-2rem)] max-h-[760px] w-[calc(100vw-2rem)] max-w-4xl flex-col overflow-hidden p-0 sm:h-[720px]"
        >
          <DialogTitle>Add {providerName} Skill</DialogTitle>
          <div className="flex-shrink-0 border-b border-border px-4 py-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
                <FileUp className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-medium text-foreground">Add {providerName} Skill</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {t('skills.uploadHint')}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                aria-label={t('skills.closeAddDialog')}
                disabled={isSubmitting}
                onClick={() => handleAddDialogOpenChange(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {uploadPanel}
          </div>

          <div className="flex flex-shrink-0 flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              {(submitError || loadError || (justInstalled && saveStatus === 'success')) ? (
                <div className={cn(
                  'max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm',
                  submitError || loadError
                    ? 'border-border bg-card text-body'
                    : 'border-primary/[0.32] bg-primary/[0.08] text-foreground dark:text-primary',
                )}>
                  {submitError || loadError || t('skills.savedOk')}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t('skills.nameHint')}
                </span>
              )}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                disabled={isSubmitting}
                onClick={() => handleAddDialogOpenChange(false)}
              >
                {t('skills.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => void handleUploadInstall()}
                disabled={isSubmitting || queuedFiles.length === 0}
              >
                {isSubmitting ? (
                  // 绿底按钮上环色走 primary-foreground,绿描边在绿底上看不见
                  <span
                    className="h-4 w-4 flex-none rounded-full border-[1.5px] border-primary-foreground"
                    aria-hidden
                  />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {queuedFiles.length > 1 ? t('skills.installMany', { count: queuedFiles.length }) : t('skills.installOne')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {!isAddDialogOpen && (submitError || loadError) && (
        <div className="rounded-md border border-border bg-card px-3 py-2 text-sm text-body">
          {submitError || loadError}
        </div>
      )}

      {justInstalled && saveStatus === 'success' && !isAddDialogOpen && (
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/[0.32] bg-primary/[0.08] px-3 py-1 text-xs font-medium text-foreground dark:text-primary">
          <CheckCircle2 className="h-4 w-4" />
          Skills saved successfully.
        </div>
      )}

      <div className="space-y-5">
        {isLoading && skills.length === 0 && (
          <div className="flex min-h-[180px] items-center justify-center text-sm text-muted-foreground">
            Loading {providerName} skills…
          </div>
        )}

        {!isLoading && skills.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
              <FileText className="h-6 w-6" />
            </div>
            <div className="mt-4 text-sm font-medium text-foreground">{t('skills.emptyTitle')}</div>
            <div className="mt-1 text-sm text-muted-foreground">
              {t('skills.emptyHint')}
            </div>
          </div>
        )}

        {!isLoading && skills.length > 0 && filteredSkills.length === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center">
            <Search className="mx-auto h-6 w-6 text-muted-foreground" />
            <div className="mt-3 text-sm font-medium text-foreground">{t('skills.noMatchTitle')}</div>
            <div className="mt-1 text-sm text-muted-foreground">
              {t('skills.noMatchHint')}
            </div>
          </div>
        )}

        {groupedSkills.map((group) => (
          <section key={group.scope} className="min-w-0 space-y-3">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn('rounded-full px-2.5 py-1 text-xs', SCOPE_BADGE_CLASSES[group.scope])}>
                {t(`skills.scope${group.scope.charAt(0).toUpperCase()}${group.scope.slice(1)}`, { defaultValue: SCOPE_LABELS[group.scope] })}
              </Badge>
              <span className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                {group.skills.length} skill{group.skills.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              {group.skills.map((skill) => (
                <div
                  key={`${skill.command}:${skill.sourcePath}:${skill.projectPath || 'global'}`}
                  className="min-w-0 rounded-lg border border-border bg-card p-4"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="break-all font-mono text-sm font-semibold text-foreground">{skill.command}</div>
                    <div className="text-sm text-muted-foreground">{skill.name}</div>
                  </div>

                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {skill.description || 'No description provided in the skill front matter.'}
                  </p>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {skill.pluginName && (
                      <Badge variant="outline" className="rounded-full bg-background">
                        Plugin: {skill.pluginName}
                      </Badge>
                    )}
                    {skill.projectDisplayName && (
                      <Badge variant="outline" className="rounded-full bg-background">
                        Project: {skill.projectDisplayName}
                      </Badge>
                    )}
                  </div>

                  <div className="mt-4 min-w-0 rounded-lg border border-border bg-card px-3 py-2">
                    <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{t('skills.source')}</div>
                    <code className="mt-1 block whitespace-normal break-all text-xs text-foreground">{skill.sourcePath}</code>
                  </div>

                  {/* F13:卸载入口。只有服务端标了 directoryName 的(用户级、受管
                      目录下一层)才画 —— 项目级用文件树删,插件级属于插件包。 */}
                  {skill.directoryName && (
                    <div className="mt-3 flex justify-end">
                      <button
                        type="button"
                        onClick={() => setPendingRemoval(skill)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('skills.remove', { defaultValue: '卸载' })}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* 删目录不可逆,所以要二次确认,并且把要删的目录写在确认里。 */}
      <Dialog open={Boolean(pendingRemoval)} onOpenChange={(open) => { if (!open) setPendingRemoval(null); }}>
        {/*
          这个确认框开在**设置弹窗之上**,而设置弹窗自己是 z-[9999]。Dialog 默认
          外壳是 z-50,不抬高的话确认框会整个躺在设置弹窗底下 —— 界面上什么都看
          不见,点也点不到(探针第一次就是这么发现的)。
        */}
        <DialogContent className="max-w-md" wrapperClassName="z-[10000]">
          <DialogTitle>{t('skills.removeTitle', { defaultValue: '卸载这个技能?' })}</DialogTitle>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('skills.removeBody', {
              name: pendingRemoval?.name ?? '',
              defaultValue: `将删除「${pendingRemoval?.name ?? ''}」的整个技能目录,不可撤销。`,
            })}
          </p>
          <code className="mt-3 block whitespace-normal break-all rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground">
            {pendingRemoval?.sourcePath}
          </code>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPendingRemoval(null)} disabled={isRemoving}>
              {t('skills.removeCancel', { defaultValue: '取消' })}
            </Button>
            <Button onClick={() => void confirmRemoval()} disabled={isRemoving}>
              {isRemoving
                ? t('skills.removing', { defaultValue: '卸载中…' })
                : t('skills.removeConfirm', { defaultValue: '卸载' })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
