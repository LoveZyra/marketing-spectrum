import { useTranslation } from 'react-i18next';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { ImageIcon, SquareSlash as SquareSlashIcon, XIcon, ChevronDown, Check, ArrowUpIcon, Cpu, FileTextIcon, LinkIcon, History, Paperclip, SquareIcon } from 'lucide-react';

import type { AttachedDoc, DocUploadProgress, QueuedDraft } from '../../hooks/useChatComposerState';
import type { PendingPermissionRequest, PermissionMode } from '../../types/types';
import { executionModeMeta, orderedExecutionModes } from '../../utils/executionModes';
import type { ProviderModelOption } from '../../../../types/app';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '../../../../shared/view/ui';

import CommandMenu from './CommandMenu';
import ImageAttachment from './ImageAttachment';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import TokenUsageSummary from './TokenUsageSummary';
import QueuedMessageCard from './QueuedMessageCard';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  isLoading: boolean;
  onAbortSession: () => void;
  /** Model alias this conversation is running (what the user picks). Null while unknown. */
  activeModel: string | null;
  /**
   * 网关实测出的真实模型名(别名 activeModel 背后实际由谁回答)。仅在自定义网关 +
   * 实测过时有值;为空则 chip 只显示别名。
   */
  activeModelReal?: string | null;
  permissionMode: PermissionMode | string;
  /** Jump straight to a gear. Tab still cycles, handled in useChatComposerState. */
  onSelectMode: (mode: PermissionMode) => void;
  /** Gears this provider actually supports. */
  availablePermissionModes: readonly (PermissionMode | string)[];
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  tokenBudget: Record<string, unknown> | null;
  onShowTokenUsage: () => void;
  /** 打开 /models 弹窗。模型徽标的点击入口 —— 和敲 /models 同一条路径。 */
  onShowModelPicker: () => void;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  queuedDraft: QueuedDraft | null;
  /**
   * F7:**服务端**排队中的那条(chat.send 撞上在跑的回合时被收下的)。
   * 与上面那份浏览器内的排队并存 —— 一份是"我主动排的",一份是"服务端替我
   * 兜住的",来源不同,能做的操作也不同(服务端那条只能撤销,不能编辑)。
   */
  serverQueued?: { preview: string; enqueuedAt: string } | null;
  onCancelServerQueued?: () => void;
  onEditQueuedDraft: () => void;
  onDeleteQueuedDraft: () => void;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  /** prism: parsed document attachments (extracted text rides with the prompt). */
  attachedDocs?: AttachedDoc[];
  onRemoveDoc?: (index: number) => void;
  onPickDocs?: (files: FileList | File[]) => void;
  onPickAnyFiles?: (files: FileList | File[]) => void;
  onAttachUrl?: (url: string) => void;
  parsingDocs?: boolean;
  /** prism: transfer progress for the generic attach path (files up to 500MB). */
  docUploadProgress?: DocUploadProgress | null;
  /** Prism: open the checkpoint history drawer. */
  onShowCheckpoints?: () => void;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openImagePicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
}

/**
 * 占位文案里的 `/` 与 `@` 按设计稿走等宽墨色,其余仍是弱化正文。
 * 只切这两个字符,不改文案本身(i18n 键不动)。
 */
function renderPlaceholderWithKeys(text: string) {
  return text.split(/([/@])/).map((part, index) => (
    part === '/' || part === '@'
      ? <span key={index} className="font-mono text-xs text-foreground">{part}</span>
      : <span key={index}>{part}</span>
  ));
}

function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  isLoading,
  onAbortSession,
  activeModel,
  activeModelReal,
  permissionMode,
  onSelectMode,
  availablePermissionModes,
  effort,
  availableEffortOptions,
  onSelectEffort,
  tokenBudget,
  onShowTokenUsage,
  onShowModelPicker,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  queuedDraft,
  serverQueued,
  onCancelServerQueued,
  onEditQueuedDraft,
  onDeleteQueuedDraft,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  attachedDocs = [],
  onRemoveDoc,
  onPickDocs,
  onPickAnyFiles,
  onAttachUrl,
  parsingDocs = false,
  docUploadProgress = null,
  onShowCheckpoints,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openImagePicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
}: ChatComposerProps) {
  const { t } = useTranslation('chat');
  // prism: hidden file input for document attachments.
  const docInputRef = useRef<HTMLInputElement>(null);
  // prism: hidden file input for the generic attach-any-file button (all types).
  const anyInputRef = useRef<HTMLInputElement>(null);

  // 模型切换后给 chip 一个短暂高亮 —— 弹窗关掉后,这是"确实切了"最直接的反馈。
  // 只在"已知模型 → 另一个已知模型"时闪,首屏加载(null→X)不算切换,不打扰。
  const [modelJustChanged, setModelJustChanged] = useState(false);
  const previousActiveModelRef = useRef<string | null>(activeModel);
  useEffect(() => {
    const previous = previousActiveModelRef.current;
    if (previous === activeModel) return;
    previousActiveModelRef.current = activeModel;
    if (!previous || !activeModel) return;
    setModelJustChanged(true);
    const timer = window.setTimeout(() => setModelJustChanged(false), 1600);
    return () => window.clearTimeout(timer);
  }, [activeModel]);

  // 网关把别名解析成的真实模型。只有实测过、且与别名不同才显示 —— 官方 API
  // 或没实测时别名本身就是答案,不必重复。
  const activeModelRealName =
    activeModelReal && activeModelReal !== activeModel ? activeModelReal : null;
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  const [isModeDropdownOpen, setIsModeDropdownOpen] = useState(false);
  const modeDropdownRef = useRef<HTMLDivElement | null>(null);
  const modeDropdownMenuRef = useRef<HTMLDivElement | null>(null);
  const modeDropdownButtonRef = useRef<HTMLButtonElement | null>(null);
  const [modeDropdownPosition, setModeDropdownPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  const executionModes = useMemo(
    () => orderedExecutionModes(availablePermissionModes),
    [availablePermissionModes],
  );
  const activeMode = executionModeMeta(permissionMode);

  const updateModeDropdownPosition = useCallback(() => {
    const rect = modeDropdownButtonRef.current?.getBoundingClientRect();
    if (!rect) return;

    setModeDropdownPosition({
      left: rect.left,
      top: rect.top - 8,
      maxHeight: Math.max(96, rect.top - 16),
    });
  }, []);

  useEffect(() => {
    if (!isModeDropdownOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !modeDropdownRef.current?.contains(target)
        && !modeDropdownMenuRef.current?.contains(target)
      ) {
        setIsModeDropdownOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsModeDropdownOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateModeDropdownPosition);
    window.addEventListener('scroll', updateModeDropdownPosition, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateModeDropdownPosition();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateModeDropdownPosition);
      window.removeEventListener('scroll', updateModeDropdownPosition, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isModeDropdownOpen, updateModeDropdownPosition]);

  const [isEffortDropdownOpen, setIsEffortDropdownOpen] = useState(false);
  const effortDropdownRef = useRef<HTMLDivElement | null>(null);
  const effortDropdownMenuRef = useRef<HTMLDivElement | null>(null);
  const effortDropdownButtonRef = useRef<HTMLButtonElement | null>(null);
  const [effortDropdownPosition, setEffortDropdownPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const effortOptions = useMemo(
    () => [{ value: 'default' }, ...availableEffortOptions],
    [availableEffortOptions],
  );
  const selectedEffortLabel = effort === 'default' ? 'Default' : effort;
  const updateEffortDropdownPosition = useCallback(() => {
    const rect = effortDropdownButtonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    setEffortDropdownPosition({
      left: rect.left,
      top: rect.top - 8,
      maxHeight: Math.max(96, rect.top - 16),
    });
  }, []);

  useEffect(() => {
    if (!isEffortDropdownOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !effortDropdownRef.current?.contains(target)
        && !effortDropdownMenuRef.current?.contains(target)
      ) {
        setIsEffortDropdownOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsEffortDropdownOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateEffortDropdownPosition);
    window.addEventListener('scroll', updateEffortDropdownPosition, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateEffortDropdownPosition();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateEffortDropdownPosition);
      window.removeEventListener('scroll', updateEffortDropdownPosition, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isEffortDropdownOpen, updateEffortDropdownPosition]);

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );


  const hasQueuedDraft = Boolean(queuedDraft);
  const canQueueDraft = isLoading && Boolean(input.trim());
  // 快捷键说明不再占底栏排版位(那段长文案被左侧一排 chip 挤压后会折行,
  // 底栏随之长高 —— 就是"对话框突然变化"的主要来源),收进发送按钮的悬停提示。
  const keyboardHint = sendByCtrlEnter
    ? t('input.hintText.ctrlEnter')
    : t('input.hintText.enter');
  // 只有"流式中回车会排队"这种**当下才成立**的短提示留在底栏。底栏可见的是
  // **短版**(几个字,窄屏也放得下,不会截成半句),整句进悬停 title。
  const submitHint = canQueueDraft
    ? hasQueuedDraft
      ? t('input.hintText.updateQueued', { defaultValue: 'Enter to update queued message' })
      : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
    : keyboardHint;
  const submitAriaLabel = canQueueDraft
    ? hasQueuedDraft
      ? t('input.queue.update', { defaultValue: 'Update queued message' })
      : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
    : t('input.send');

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      {queuedDraft && (
        <QueuedMessageCard
          content={queuedDraft.content}
          imageCount={queuedDraft.images.length}
          onEdit={onEditQueuedDraft}
          onDelete={onDeleteQueuedDraft}
        />
      )}

      {serverQueued && (
        <QueuedMessageCard
          content={serverQueued.preview}
          label={t('input.queue.serverLabel', { defaultValue: '服务端已收下' })}
          hint={t('input.queue.serverHint', { defaultValue: '本轮结束后自动发送 · 关掉页面也有效' })}
          onDelete={onCancelServerQueued ?? (() => {})}
        />
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-[54.25rem]">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="prism-modal-shadow absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`cursor-pointer touch-manipulation border-b border-border px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-foreground dark:text-primary'
                    : 'text-foreground hover:bg-accent'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={isTextareaExpanded ? 'chat-input-expanded' : ''}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/[0.32] bg-primary/[0.08]">
              <div className="prism-modal-shadow rounded-lg border border-border bg-popover p-4">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">松手即可添加附件</p>
                <p className="mt-0.5 text-xs text-muted-foreground">图片随消息一起发送,其他文件落到项目里</p>
              </div>
            </div>
          )}

          {(attachedImages.length > 0 || attachedDocs.length > 0 || parsingDocs) && (
            <PromptInputHeader>
              <div className="rounded-md bg-transparent p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                  {attachedDocs.map((doc, index) => (
                    <span
                      key={`${doc.name}-${index}`}
                      className="inline-flex max-w-56 items-center gap-1.5 rounded-sm border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
                      title={
                        /* A landed file has no extracted body, so a character
                           count would describe the path string rather than the
                           document — show the path itself instead. */
                        doc.kind === 'path'
                          ? `${doc.name}\n${doc.text}`
                          : `${doc.name} — ${doc.chars.toLocaleString()} chars${doc.truncated ? ' (truncated)' : ''}`
                      }
                    >
                      {doc.source === 'url'
                        ? <LinkIcon className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                        : <FileTextIcon className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
                      <span className="truncate">{doc.name}</span>
                      <span className="flex-shrink-0 text-[10px] text-muted-foreground">
                        {doc.kind === 'path'
                          ? t('input.attachmentPath', { defaultValue: 'path' })
                          : doc.chars >= 1000 ? `${Math.round(doc.chars / 1000)}k` : doc.chars}
                      </span>
                      {onRemoveDoc && (
                        <button
                          type="button"
                          onClick={() => onRemoveDoc(index)}
                          className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          aria-label={t('input.removeDocument', { defaultValue: 'Remove document' })}
                        >
                          <XIcon className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  ))}
                  {parsingDocs && (
                    docUploadProgress ? (
                      /* A large attachment transfers for minutes, so it gets a
                         real bar instead of the bare spinner: the filename says
                         which file, the percentage says it is still moving. */
                      <span
                        className="inline-flex min-w-48 max-w-64 flex-col gap-1 rounded-sm border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground"
                        role="status"
                        aria-live="polite"
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="h-3.5 w-3.5 flex-none rounded-full border-[1.5px] border-primary" aria-hidden />
                          <span className="truncate" title={docUploadProgress.fileName}>
                            {docUploadProgress.fileName}
                          </span>
                          {docUploadProgress.total > 1 && (
                            <span className="flex-shrink-0 text-[10px]">
                              {docUploadProgress.index + 1}/{docUploadProgress.total}
                            </span>
                          )}
                          <span className="ml-auto flex-shrink-0 tabular-nums">
                            {docUploadProgress.percent === null ? '…' : `${docUploadProgress.percent}%`}
                          </span>
                        </span>
                        <span className="h-1 w-full overflow-hidden rounded-full bg-muted">
                          <span
                            className={`block h-full rounded-full bg-primary ${
                              // Before the first progress event there is no ratio to
                              // render, so the bar pulses rather than showing a
                              // stalled-looking empty track.
                              docUploadProgress.percent === null ? 'w-1/3' : 'transition-[width] duration-200'
                            }`}
                            style={docUploadProgress.percent === null ? undefined : { width: `${docUploadProgress.percent}%` }}
                          />
                        </span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
                        <span className="h-3.5 w-3.5 flex-none rounded-full border-[1.5px] border-primary" aria-hidden />
                        {t('input.parsingDocument', { defaultValue: 'Parsing document…' })}
                      </span>
                    )
                  )}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />
          {onPickDocs && (
            <input
              ref={docInputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.pptx,.xlsx,.xlsm,.xls,.csv,.tsv,.txt,.md,.json,.log,.xml,.yaml,.yml,.html,.htm"
              className="hidden"
              onChange={(event) => {
                if (event.target.files && event.target.files.length > 0) {
                  onPickDocs(event.target.files);
                }
                event.target.value = '';
              }}
            />
          )}
          {onPickAnyFiles && (
            <input
              ref={anyInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files && event.target.files.length > 0) {
                  onPickAnyFiles(event.target.files);
                }
                event.target.value = '';
              }}
            />
          )}

          <PromptInputBody>
            {/* @提及高亮层必须和 textarea 逐像素同源:同样 p-0 / 14px / 23px 行高。
                容器内边距在 form 上,这一层再补 padding 就会整体错位。 */}
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words p-0 text-sm leading-[23px] text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            {/* 占位文案:设计稿里 `/` 与 `@` 是等宽墨色,原生 placeholder 无法分段
                着色,所以空输入时改用同源的覆盖层,textarea 只留 aria-label。 */}
            {!input && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-hidden text-sm leading-[23px] text-muted-foreground"
              >
                {renderPlaceholderWithKeys(placeholder)}
              </div>
            )}

            <PromptInputTextarea
              ref={textareaRef}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder=""
              aria-label={placeholder}
            />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            {onPickAnyFiles && (
              <PromptInputButton
                tooltip={{ content: t('input.attachFiles', { defaultValue: 'Attach any file — saved to disk for the agent to process' }) }}
                onClick={() => anyInputRef.current?.click()}
              >
                <Paperclip />
              </PromptInputButton>
            )}
            <PromptInputButton
              tooltip={{ content: t('input.attachImages') }}
              onClick={openImagePicker}
            >
              <ImageIcon />
            </PromptInputButton>

            {onPickDocs && (
              <PromptInputButton
                tooltip={{ content: t('input.attachDocuments', { defaultValue: 'Attach documents (PDF, Word, Excel, PPT…)' }) }}
                onClick={() => docInputRef.current?.click()}
              >
                <FileTextIcon />
              </PromptInputButton>
            )}

            {onAttachUrl && (
              <PromptInputButton
                tooltip={{ content: t('input.attachUrl', { defaultValue: 'Fetch a URL as context' }) }}
                onClick={() => {
                  const url = window.prompt(
                    t('input.attachUrlPrompt', { defaultValue: 'Enter a URL to fetch its readable text:' }) || '',
                  );
                  if (url && url.trim()) onAttachUrl(url.trim());
                }}
              >
                <LinkIcon />
              </PromptInputButton>
            )}

            {/* 排序不变量:**固定图标一律排在会变宽/会出现消失的 chip 前面**。
                模型 chip(实测名加载后变长)、Effort(随模型出现/消失)、tokens
                (会话中途出现)都在图标之后 —— 它们的变化只向右侧空白扩展,
                图标位置因此纹丝不动。谁要往这行加东西,按这条规则放位置。 */}
            {onShowCheckpoints && (
              <PromptInputButton
                tooltip={{ content: t('checkpoint.historyTitle', { defaultValue: '检查点历史' }) }}
                onClick={onShowCheckpoints}
              >
                <History />
              </PromptInputButton>
            )}

            {/* 斜杠命令入口。
                图标从 MessageSquare(一个对话气泡,和"命令"毫无关系)换成 SquareSlash ——
                框里一个「/」,正是输入框里唤起它的那个字符。
                角标去掉了:那个数字是"可用命令有多少条",既不是待办也不是未读,
                摆一个绿色圆点角标在那儿只会让人以为有什么东西需要处理。
                条数在展开的命令面板里本来就看得到。 */}
            <PromptInputButton
              tooltip={{ content: t('input.showAllCommands') }}
              onClick={onToggleCommandMenu}
            >
              <SquareSlashIcon />
            </PromptInputButton>

            {/* 清空按钮:**常驻占位**,无输入时只是隐形(invisible 仍占宽)。
                以前是"打字才出现",输入从空到非空的瞬间整排图标被挤一下 ——
                恰恰是最高频的"图标动了"。 */}
            <PromptInputButton
              tooltip={hasInput ? { content: t('input.clearInput', { defaultValue: 'Clear input' }) } : undefined}
              onClick={onClearInput}
              disabled={!hasInput}
              className={`hidden sm:flex ${hasInput ? '' : 'invisible'}`}
            >
              <XIcon />
            </PromptInputButton>

            {/* Which model is actually running — click to switch.
                Originally read-only with "输入 /models 切换" in the tooltip;
                that made the one visible model indicator a dead end while the
                switcher hid behind a slash command. Clicking goes through the
                exact same executeCommand('/models') path as typing it, so both
                entrances feed the modal identical data. */}
            {activeModel && (
              <button
                type="button"
                onClick={onShowModelPicker}
                className={`inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  modelJustChanged
                    ? 'border-primary/30 bg-primary/8 text-foreground ring-2 ring-primary/30 dark:text-primary'
                    : 'border-border text-card-foreground hover:border-border-strong'
                }`}
                title={
                  activeModelRealName
                    ? `别名 ${activeModel} · 实际模型 ${activeModelRealName}，点击切换`
                    : t('input.modelHint', { model: activeModel, defaultValue: `当前模型：${activeModel}，点击切换` })
                }
                aria-label={
                  activeModelRealName
                    ? `别名 ${activeModel} · 实际模型 ${activeModelRealName}，点击切换`
                    : t('input.modelHint', { model: activeModel, defaultValue: `当前模型：${activeModel}，点击切换` })
                }
              >
                <Cpu className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {activeModelRealName ? (
                  // 只显示实际生效的模型名 —— 别名(default/sonnet…)是内部转发细节,
                  // 用户关心"现在到底是谁在答"。别名仍在 hover 提示里可查。
                  <span className="hidden max-w-56 truncate font-semibold sm:inline">{activeModelRealName}</span>
                ) : (
                  <span className="hidden max-w-28 truncate sm:inline">{activeModel}</span>
                )}
              </button>
            )}

            {/* Execution mode.
                This used to be a single button that cycled through five modes
                with nothing but a colour to distinguish them — including two
                that let the agent write files or run commands unattended. It is
                a labelled picker now, with one line each on what the gear
                actually permits. Tab still cycles, for anyone with the old
                muscle memory. */}
            <div ref={modeDropdownRef} className="relative">
              <button
                ref={modeDropdownButtonRef}
                type="button"
                onClick={() => {
                  updateModeDropdownPosition();
                  setIsModeDropdownOpen((current) => !current);
                }}
                className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs transition-colors ${activeMode.chipClassName}`}
                aria-haspopup="menu"
                aria-expanded={isModeDropdownOpen}
                aria-label={t('executionModes.title', { defaultValue: 'Execution mode' })}
                title={t('input.clickToChangeMode')}
              >
                <div className="flex items-center gap-1.5">
                  <div className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${activeMode.dotClassName}`} />
                  <span className="hidden whitespace-nowrap sm:inline">{t(activeMode.labelKey)}</span>
                  <ChevronDown className={`h-3 w-3 transition-transform ${isModeDropdownOpen ? 'rotate-180' : ''}`} />
                </div>
              </button>

              {isModeDropdownOpen && modeDropdownPosition && createPortal(
                <div
                  ref={modeDropdownMenuRef}
                  className="prism-modal-shadow fixed z-[100] w-72 overflow-y-auto rounded-lg border border-border bg-popover p-1"
                  style={{
                    left: modeDropdownPosition.left,
                    top: modeDropdownPosition.top,
                    maxHeight: modeDropdownPosition.maxHeight,
                    transform: 'translateY(-100%)',
                  }}
                  role="menu"
                >
                  {executionModes.map((option) => {
                    const isSelected = option.mode === permissionMode;
                    return (
                      <button
                        key={option.mode}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => {
                          onSelectMode(option.mode);
                          setIsModeDropdownOpen(false);
                        }}
                        className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                          isSelected ? 'bg-accent text-foreground' : 'hover:bg-accent'
                        }`}
                      >
                        <span className="flex h-4 w-3 shrink-0 items-center justify-center">
                          {isSelected && <Check className="h-3 w-3 text-primary" />}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                            <span className={`h-1.5 w-1.5 rounded-full ${option.dotClassName}`} />
                            {t(option.labelKey)}
                          </span>
                          <span className="text-[11px] leading-snug text-muted-foreground">
                            {t(option.descriptionKey)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}
            </div>

            {availableEffortOptions.length > 0 && (
              <div ref={effortDropdownRef} className="relative">
                <button
                  ref={effortDropdownButtonRef}
                  type="button"
                  onClick={() => {
                    updateEffortDropdownPosition();
                    setIsEffortDropdownOpen((current) => !current);
                  }}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-card-foreground transition-colors hover:border-border-strong"
                  aria-haspopup="menu"
                  aria-expanded={isEffortDropdownOpen}
                  aria-label="Select reasoning effort"
                  title="Select reasoning effort"
                >
                  <span className="hidden text-[11px] text-muted-foreground sm:inline">Effort</span>
                  <span className="max-w-16 truncate capitalize sm:max-w-20">{selectedEffortLabel}</span>
                  <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${isEffortDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {isEffortDropdownOpen && effortDropdownPosition && createPortal(
                  <div
                    ref={effortDropdownMenuRef}
                    className="prism-modal-shadow fixed z-[100] min-w-36 overflow-y-auto rounded-lg border border-border bg-popover p-1"
                    style={{
                      left: effortDropdownPosition.left,
                      top: effortDropdownPosition.top,
                      maxHeight: effortDropdownPosition.maxHeight,
                      transform: 'translateY(-100%)',
                    }}
                    role="menu"
                  >
                    {effortOptions.map((option) => {
                      const isSelected = option.value === effort;
                      const label = option.value === 'default' ? 'Default' : option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          onClick={() => {
                            onSelectEffort(option.value);
                            setIsEffortDropdownOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs capitalize transition-colors ${
                            isSelected
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          }`}
                        >
                          <span className="flex h-3 w-3 items-center justify-center">
                            {isSelected && <Check className="h-3 w-3 text-primary" />}
                          </span>
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>,
                  document.body,
                )}
              </div>
            )}

            <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />

          </PromptInputTools>

          <div className="ml-auto flex min-w-0 flex-none items-center justify-end gap-2">
            {/* 底栏不放任何文字提示 —— 会把右侧两个按钮挤得来回移位。
                "回车=排队"的说明收进发送按钮的悬停 title(见下)。 */}
            {/* 中止:跑起来才出现,描边方块。它和发送并排 ——
                这样"有草稿时点发送=排队、想停就点方块"两件事各有各的按钮,
                不用再让同一个按钮身兼二职。 */}
            {isLoading && (
              <button
                type="button"
                onClick={onAbortSession}
                aria-label={t('input.stop', { defaultValue: '停止' })}
                title={t('input.stop', { defaultValue: '停止' })}
                className="grid h-8 w-8 flex-none place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground active:translate-y-px"
              >
                <SquareIcon className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            )}

            {/* 三种状态,按钮数量跟着变:
                没在跑 → 只有发送;在跑且没草稿 → 只有停止;在跑且有草稿 → 两个都在。
                在跑且没草稿时留一个禁用的发送按钮没有意义,只会让人误点。 */}
            {(!isLoading || canQueueDraft) && (
              <PromptInputSubmit
                onClick={
                  canQueueDraft
                    ? (e: MouseEvent<HTMLButtonElement>) => {
                        e.preventDefault();
                        onSubmit(e);
                      }
                    : undefined
                }
                disabled={!input.trim()}
                aria-label={submitAriaLabel}
                // 悬停提示带上完整快捷键说明(底栏那段长文案删了,信息收到这里)。
                title={`${submitAriaLabel} · ${submitHint}`}
                className="h-8 w-8 flex-none px-0"
              >
                <ArrowUpIcon className="h-4 w-4" strokeWidth={2} />
              </PromptInputSubmit>
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>}
    </div>
  );
}

/**
 * memo 的动机:这是聊天页最大的单个组件(约 950 行的输入区),而流式期间
 * store 每 100ms 通知一次 ChatInterface 重渲 —— 输入区里没有任何东西在变,
 * 却整棵陪跑。props 里的回调都来自 useCallback(ChatInterface 侧的内联箭头
 * 已一并收敛),浅比较在打字/拖拽之外的时刻都能命中。
 */
export default memo(ChatComposer);
