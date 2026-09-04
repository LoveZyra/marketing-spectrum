import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, FolderPlus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 项目 / 会话 / 模型三个下拉的**唯一实现**(从 TasksPage 抽出来)。
 *
 * 抽出来是为了别处要用同一套交互时用同一段代码 —— 抄出来的第二份迟早会漂。
 * 所以这里连同它的行为细节一起搬:搜索、名称/路径两行、选中勾、面板
 * portal 到 body(祖先的 overflow 会把弹层裁成半截)、上下翻转、Esc 只关面板。
 */

export type FancyOption = {
  value: string;
  label: string;
  sublabel?: string;
  /** 主行用等宽字体(模型名、路径这类"机器串"),对齐 /models 卡片的排版。 */
  mono?: boolean;
};

export function FancySelect({
  value, options, onChange, placeholder, searchable, searchPlaceholder, variant, className, footer,
}: {
  value: string;
  options: FancyOption[];
  onChange: (next: string) => void;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** chip = 指令框底部的小胶囊;field = 表单里的整宽控件。 */
  variant: 'chip' | 'field';
  className?: string;
  /** 面板底部动作区(项目下拉的「新建项目 / 其他目录…」)。 */
  footer?: (close: () => void) => ReactNode;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 面板挂在 body 上(见下),所以位置得自己算:触发器的视口坐标 + 上下翻转。
  const [rect, setRect] = useState<{ left: number; top: number; width: number; flip: boolean } | null>(null);
  const close = () => { setOpen(false); setQuery(''); };
  const current = options.find((option) => option.value === value);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((option) => `${option.label}\n${option.sublabel ?? ''}`.toLowerCase().includes(needle))
    : options;
  const triggerClass = variant === 'chip'
    ? 'inline-flex h-7 w-full items-center justify-between gap-1 rounded-md border border-border bg-card px-2 text-xs text-foreground transition-colors hover:border-border-strong focus:border-primary focus:outline-none'
    : 'flex w-full items-center justify-between gap-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:border-border-strong focus:border-primary focus:outline-none';

  const PANEL_MAX_HEIGHT = 320; // 搜索框 + 列表 + footer 的上限,和下面的 max-h 对齐

  /** 量一次触发器,决定面板贴在它下面还是上面。 */
  const measure = useCallback(() => {
    const element = triggerRef.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    const flip = below < PANEL_MAX_HEIGHT && box.top > below; // 下面放不下且上面更宽敞
    setRect({
      left: Math.min(box.left, Math.max(8, window.innerWidth - 8 - Math.max(box.width, 288))),
      top: flip ? box.top - 4 : box.bottom + 4,
      width: Math.max(box.width, 288),
      flip,
    });
  }, []);

  // 开着的时候跟随滚动/缩放重新量 —— 面板是 fixed 的,不跟随祖先滚动。
  // Esc 关面板(而不是穿透去关整个弹窗)。
  useEffect(() => {
    if (!open) return undefined;
    measure();
    const onMove = () => measure();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, measure]);

  return (
    <div className={`relative min-w-0 ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className={triggerClass}
        title={current?.sublabel || current?.label || placeholder}
      >
        <span className={`truncate ${current ? '' : 'text-muted-foreground'}`}>{current ? current.label : (placeholder ?? '—')}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
      </button>
      {/*
        面板 **portal 到 body**:留在原地会被祖先的 overflow 裁掉 —— 指令框那圈
        `overflow-hidden`、以及弹窗自身的 `overflow-y-auto`,两处都把弹层切成
        半截(用户反馈)。挂到 body + position:fixed 就谁也裁不到,代价是位置
        得自己算(measure)。
      */}
      {open && rect && createPortal(
        <>
          <div className="fixed inset-0 z-[100]" onClick={close} aria-hidden />
          <div
            className="prism-modal-shadow fixed z-[101] flex max-h-80 flex-col overflow-hidden rounded-lg border border-border bg-popover"
            style={{
              left: rect.left,
              width: rect.width,
              ...(rect.flip ? { bottom: window.innerHeight - rect.top } : { top: rect.top }),
            }}
          >
            {searchable && (
              <div className="flex flex-none items-center gap-1.5 border-b border-border px-2.5 py-2">
                <Search className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                <input
                  ref={(element) => element?.focus()}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {shown.length === 0 && (
                <p className="px-3 py-2 text-xs text-muted-foreground">{t('tasksPage.select.noMatch', { defaultValue: '没有匹配项' })}</p>
              )}
              {shown.map((option) => (
                <button
                  key={option.value || '__empty__'}
                  type="button"
                  onClick={() => { onChange(option.value); close(); }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted ${option.value === value ? 'bg-muted/60' : ''}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate leading-5 text-foreground ${option.mono ? 'font-mono text-[12.5px] font-semibold' : 'text-[13px]'}`}>
                      {option.label}
                    </span>
                    {option.sublabel && (
                      <span className={`block truncate leading-4 text-muted-foreground ${option.mono ? 'font-mono text-[11px]' : 'text-[11px]'}`}>
                        {option.sublabel}
                      </span>
                    )}
                  </span>
                  {option.value === value && <Check className="h-3.5 w-3.5 flex-none text-primary" />}
                </button>
              ))}
            </div>
            {footer && <div className="flex-none border-t border-border">{footer(close)}</div>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

/**
 * 项目下拉底部的「选择其它目录…」:开**创建新项目那套「选择文件夹」浏览器**
 * (FolderBrowserModal,能逐级浏览、能新建文件夹),而不是让用户手打绝对路径
 * (用户点名)。
 *
 * 点它先把下拉面板收起来:面板是 z-101 的 portal,folder 浏览器是 z-70,
 * 不收起来面板会压在浏览器弹窗上面。浏览器本体由**表单**持有(见 TaskFormModal),
 * 因为面板一关这个 footer 就卸载了,弹窗挂在这儿会跟着消失。
 */
export function BrowseFolderFooter({ onBrowse, close }: { onBrowse: () => void; close: () => void }) {
  const { t } = useTranslation('common');
  return (
    <button
      type="button"
      onClick={() => { close(); onBrowse(); }}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted"
    >
      <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
      {t('tasksPage.select.browseFolder', { defaultValue: '选择其它目录…' })}
    </button>
  );
}
