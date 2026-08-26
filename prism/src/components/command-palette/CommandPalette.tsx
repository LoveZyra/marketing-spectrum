import * as React from 'react';
import { useCommandState } from 'cmdk';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  FileText,
  MessageSquare,
  MessageSquarePlus,
  Settings,
  SunMoon,
  X,
} from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../shared/view/ui';
import { useTheme } from '../../contexts/ThemeContext';
import { usePaletteOps, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { SETTINGS_MAIN_TABS } from '../settings/constants/constants';
import { useAuth } from '../auth/context/AuthContext';
import type { AppTab, Project } from '../../types/app';

import { useSessionsSource } from './sources/useSessionsSource';
import { useFilesSource } from './sources/useFilesSource';
import { useSessionMessageSearch } from './sources/useSessionMessageSearch';

type Page = 'actions' | 'files' | 'sessions';

type CommandPaletteProps = {
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowTab?: (tab: AppTab) => void;
};

// label 走 i18n key(渲染时取),keywords 保留英文供 cmdk 匹配 —— value 里两者都放,
// 中英文搜索都命中。
const NAV_TABS: Array<{ id: AppTab; labelKey: string; keywords: string }> = [
  { id: 'chat', labelKey: 'palette.goToChat', keywords: 'chat messages conversation' },
  { id: 'files', labelKey: 'palette.goToFiles', keywords: 'files file tree explorer' },
  { id: 'shell', labelKey: 'palette.goToShell', keywords: 'shell terminal console' },
];

export default function CommandPalette({
  selectedProject,
  onStartNewChat,
  onOpenSettings,
  onShowTab,
}: CommandPaletteProps) {
  const { t } = useTranslation(['common', 'settings']);
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [pages, setPages] = React.useState<Page[]>([]);
  const { toggleDarkMode } = useTheme();

  const pageLabel = React.useCallback(
    (p: Page) => t(`palette.pages.${p}`, { defaultValue: p }),
    [t],
  );
  const navigate = useNavigate();
  const isRoot = Boolean(useAuth().user?.isRoot);
  const ops = usePaletteOps();

  // 鼠标入口:侧栏搜索框右侧那个 ⌘K 键帽点一下就开(键盘仍走下面的全局监听)。
  const openPalette = React.useCallback(() => setOpen(true), []);
  usePaletteOpsRegister({ openPalette });

  const page = pages.at(-1);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k';
      if (!isCmdK) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setPages([]);
    }
  }, [open]);

  const projectId = selectedProject?.projectId;

  const showActions = !page || page === 'actions';
  const showSessions = !page || page === 'sessions';
  const showFiles = !page || page === 'files';

  const sessions = useSessionsSource(projectId, open && showSessions);
  const messageMatches = useSessionMessageSearch(projectId, search, open && showSessions);
  const files = useFilesSource(projectId, open && showFiles);

  const sessionRows = React.useMemo(() => {
    if (!showSessions) return [];
    type Row = { id: string; label: string; provider?: string; snippet?: string };
    const byId = new Map<string, Row>();
    for (const s of sessions) {
      byId.set(s.id, { id: s.id, label: s.label, provider: s.provider });
    }
    for (const m of messageMatches) {
      const existing = byId.get(m.sessionId);
      if (existing) {
        existing.snippet = m.snippet;
      } else {
        byId.set(m.sessionId, {
          id: m.sessionId,
          label: m.label,
          provider: m.provider,
          snippet: m.snippet,
        });
      }
    }
    return Array.from(byId.values());
  }, [sessions, messageMatches, showSessions]);

  const run = React.useCallback((fn: () => void) => {
    setOpen(false);
    fn();
  }, []);

  const pushPage = React.useCallback((next: Page) => {
    setSearch('');
    setPages((prev) => [...prev, next]);
  }, []);

  const popPage = React.useCallback(() => {
    setSearch('');
    setPages((prev) => prev.slice(0, -1));
  }, []);

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !search && pages.length > 0) {
      e.preventDefault();
      popPage();
    }
  }, [search, pages.length, popPage]);

  const startNewChatDisabled = !selectedProject;
  const browseLimit = 5;
  const filesShown = page === 'files' ? files : files.slice(0, browseLimit);
  const sessionsShown = page === 'sessions' ? sessionRows : sessionRows.slice(0, browseLimit);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl overflow-hidden bg-background p-0">
        <DialogTitle>{t('palette.title')}</DialogTitle>
        <Command label={t('palette.title')} onKeyDown={handleKeyDown}>
          {page && (
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <span className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-[11px] text-card-foreground">
                {pageLabel(page)}
                <button
                  type="button"
                  onClick={popPage}
                  aria-label={t('palette.backToAll')}
                  className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{t('palette.backspaceHint')}</span>
            </div>
          )}
          <CommandInput
            placeholder={page ? t('palette.searchPage', { page: pageLabel(page) }) : t('palette.searchAnything')}
            value={search}
            onValueChange={setSearch}
          >
            <ResultCount />
          </CommandInput>
          <CommandList>
            <CommandEmpty>{t('palette.noResults')}</CommandEmpty>

            {showActions && (
              <CommandGroup heading={t('palette.groupActions')}>
                <CommandItem
                  value={`${t('palette.startNewChat')} Start new chat`}
                  disabled={startNewChatDisabled}
                  onSelect={() => {
                    if (!selectedProject) return;
                    run(() => onStartNewChat(selectedProject));
                  }}
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('palette.startNewChat')}</span>
                  {startNewChatDisabled && (
                    <span className="text-xs text-muted-foreground">{t('palette.selectProjectFirst')}</span>
                  )}
                </CommandItem>
                <CommandItem value={`${t('palette.openSettings')} Open settings`} onSelect={() => run(() => onOpenSettings())}>
                  <Settings className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('palette.openSettings')}</span>
                </CommandItem>
                <CommandItem value={`${t('palette.toggleTheme')} Toggle theme dark light mode`} onSelect={() => run(toggleDarkMode)}>
                  <SunMoon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{t('palette.toggleTheme')}</span>
                </CommandItem>
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading={t('palette.groupNavigate')}>
                {NAV_TABS.map((tab) => (
                  <CommandItem
                    key={tab.id as string}
                    value={`${t(tab.labelKey)} ${tab.keywords}`}
                    onSelect={() => run(() => onShowTab?.(tab.id))}
                  >
                    <span className="flex-1">{t(tab.labelKey)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showActions && (
              <CommandGroup heading={t('palette.groupSettings')}>
                {SETTINGS_MAIN_TABS.filter(({ rootOnly }) => !rootOnly || isRoot).map(({ id, label, labelKey, keywords, icon: Icon }) => (
                  <CommandItem
                    key={id}
                    value={`${t(`settings:${labelKey}`, { defaultValue: label })} Settings ${label} ${keywords}`}
                    onSelect={() => run(() => onOpenSettings(id))}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{t('palette.settingsPrefix', { label: t(`settings:${labelKey}`, { defaultValue: label }) })}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {showSessions && projectId && sessionsShown.length > 0 && (
              <CommandGroup heading={t('palette.groupSessions')}>
                {sessionsShown.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={`${s.label} ${s.snippet ?? ''} ${s.id}`.trim()}
                    onSelect={() => run(() => navigate(`/session/${s.id}`))}
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{s.label}</span>
                      {s.snippet && (
                        <span className="truncate font-mono text-[10.5px] text-muted-foreground">{s.snippet}</span>
                      )}
                    </div>
                    {s.provider && (
                      <span className="flex-none font-mono text-[10.5px] text-muted-foreground">{s.provider}</span>
                    )}
                  </CommandItem>
                ))}
                {!page && sessionRows.length > browseLimit && (
                  <BrowseAllItem label={t('palette.browseAllSessions', { count: sessionRows.length })} onSelect={() => pushPage('sessions')} />
                )}
              </CommandGroup>
            )}

            {showFiles && projectId && filesShown.length > 0 && (
              <CommandGroup heading={t('palette.groupFiles')}>
                {filesShown.map((f) => (
                  <CommandItem
                    key={f.path}
                    value={f.path}
                    onSelect={() => run(() => ops.openFile(f.path))}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{f.path}</span>
                  </CommandItem>
                ))}
                {!page && files.length > browseLimit && (
                  <BrowseAllItem label={t('palette.browseAllFiles', { count: files.length })} onSelect={() => pushPage('files')} />
                )}
              </CommandGroup>
            )}

          </CommandList>

          {/* 底部提示条(设计稿 2a/2b):等宽 10.5px,沉降底 */}
          <div className="flex items-center gap-3 border-t border-border bg-card px-4 py-2.5 font-mono text-[10.5px] text-muted-foreground">
            <span>↑↓ 选择</span>
            <span>↵ 打开</span>
            <span>esc 关闭</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** 搜索行右侧的等宽结果计数(设计稿 2a/2b),读的是 cmdk 过滤后的真实条数。 */
function ResultCount() {
  const count = useCommandState((state) => state.filtered.count);
  return <span className="flex-none font-mono text-[11px] text-muted-foreground">{count}</span>;
}

function BrowseAllItem({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <CommandItem value={label} onSelect={onSelect}>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 text-muted-foreground">{label}</span>
    </CommandItem>
  );
}
