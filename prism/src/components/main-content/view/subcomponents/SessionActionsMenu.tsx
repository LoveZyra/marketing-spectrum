import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, Copy, Download, MoreHorizontal, Pin, Trash2, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import type { SessionExportFormat } from '../../../../utils/session-export';

export type SessionExportOptions = { format: SessionExportFormat; includeTools: boolean };

type Props = {
  /** 会话在服务端挂着常驻运行时(由 /runtime 实测,不是猜的)。 */
  isPersistent: boolean;
  /** 常驻开关正在请求中 —— 行上转成禁用,避免连点。 */
  persistentBusy?: boolean;
  onTogglePersistent: (next: boolean) => void;
  onExport: (options: SessionExportOptions) => void;
  isExporting?: boolean;
  projectPath: string;
  onCopyPath: () => void;
  onDelete: () => void;
  /** eh:菜单打开时回查一次常驻状态 —— 这行显示的是服务端实况,不该拿挂载那一刻的旧值。 */
  onOpen?: () => void;
};

const FORMATS: Array<{ value: SessionExportFormat; label: string; hintKey: string; hint: string }> = [
  { value: 'md', label: 'Markdown', hintKey: 'export.mdHint', hint: '给人读、贴进文档' },
  { value: 'html', label: 'HTML', hintKey: 'export.htmlHint', hint: '独立网页,双击即看' },
  { value: 'json', label: 'JSON', hintKey: 'export.jsonHint', hint: '给程序读、二次加工' },
];

const ROW_CLASS = 'flex h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors';

/**
 * 顶栏右侧的「…」(设计稿 SidebarHeader 画板右上那枚菜单)。
 *
 * 四行:导出对话… / 常驻会话 / 复制项目路径 / 删除会话(前面一条发丝线)。
 * 「导出对话…」把同一个浮层翻到第二页选格式 —— 一个 176px 的面板,两页,
 * 不再为了选个格式弹第二层浮层。
 */
export default function SessionActionsMenu({
  isPersistent,
  persistentBusy = false,
  onTogglePersistent,
  onExport,
  isExporting = false,
  projectPath,
  onCopyPath,
  onDelete,
  onOpen,
}: Props) {
  const { t } = useTranslation('common');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [page, setPage] = useState<'main' | 'export'>('main');
  const [includeTools, setIncludeTools] = useState(false);

  const close = () => { setAnchor(null); setPage('main'); };

  useEffect(() => {
    if (!anchor) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const onScroll = () => close();
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [anchor]);

  const open = () => {
    const box = triggerRef.current?.getBoundingClientRect();
    if (!box) return;
    const width = 200;
    setAnchor({
      left: Math.min(box.right - width, Math.max(8, window.innerWidth - 8 - width)),
      top: box.bottom + 6,
    });
    onOpen?.();
  };

  const row = (
    key: string,
    Icon: LucideIcon,
    label: string,
    onSelect: () => void,
    options: { danger?: boolean; disabled?: boolean; trailing?: string } = {},
  ) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      data-session-action={key}
      disabled={options.disabled}
      onClick={onSelect}
      className={cn(
        ROW_CLASS,
        options.danger
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-body hover:bg-muted hover:text-foreground',
        options.disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <Icon className="h-3.5 w-3.5 flex-none" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {options.trailing && (
        <span className="flex-none font-mono text-[10.5px] text-muted-foreground">{options.trailing}</span>
      )}
    </button>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-main-menu
        onClick={() => (anchor ? close() : open())}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        aria-label={t('mainContent.more', { defaultValue: '更多' })}
        title={t('mainContent.more', { defaultValue: '更多' })}
        className="grid h-6 w-7 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>

      {anchor && createPortal(
        <div
          ref={panelRef}
          role="menu"
          data-main-menu-panel
          style={{ left: anchor.left, top: anchor.top }}
          className="prism-modal-shadow fixed z-[101] w-[200px] rounded-panel border border-border bg-popover p-1"
        >
          {page === 'main' ? (
            <>
              {row('export', Download, t('mainContent.exportSession', { defaultValue: '导出对话' }) + '…', () => setPage('export'), { disabled: isExporting })}
              {row(
                'persistent',
                Pin,
                t('mainContent.persistentSession', { defaultValue: '常驻会话' }),
                () => { onTogglePersistent(!isPersistent); close(); },
                {
                  disabled: persistentBusy,
                  trailing: isPersistent
                    ? t('mainContent.persistentOn', { defaultValue: '已开' })
                    : t('mainContent.persistentOff', { defaultValue: '未开' }),
                },
              )}
              {projectPath && row('copy-path', Copy, t('mainContent.copyProjectPath', { defaultValue: '复制项目路径' }), () => { onCopyPath(); close(); })}
              <div className="mx-1.5 my-1 h-px bg-border" />
              {row('delete', Trash2, t('mainContent.deleteSession', { defaultValue: '删除会话' }), () => { onDelete(); close(); }, { danger: true })}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPage('main')}
                className={cn(ROW_CLASS, 'text-muted-foreground hover:bg-muted hover:text-foreground')}
              >
                <ChevronLeft className="h-3.5 w-3.5 flex-none" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t('mainContent.exportSession', { defaultValue: '导出对话' })}</span>
              </button>
              {FORMATS.map((format) => (
                <button
                  key={format.value}
                  type="button"
                  role="menuitem"
                  onClick={() => { onExport({ format: format.value, includeTools }); close(); }}
                  className="flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted"
                >
                  <span className="text-[13px] text-foreground">{format.label}</span>
                  <span className="text-[11px] text-muted-foreground">{t(format.hintKey, { defaultValue: format.hint })}</span>
                </button>
              ))}
              <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-border px-2.5 py-2 text-xs text-body hover:text-foreground">
                <input
                  type="checkbox"
                  checked={includeTools}
                  onChange={(event) => setIncludeTools(event.target.checked)}
                  className="h-3.5 w-3.5"
                />
                {t('export.includeTools', { defaultValue: '含工具过程' })}
              </label>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
