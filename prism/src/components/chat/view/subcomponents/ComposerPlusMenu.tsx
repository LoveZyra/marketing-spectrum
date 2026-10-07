import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';

export type ComposerPlusMenuItem = {
  id: string;
  icon: ReactNode;
  label: string;
  /** 一行灰字说明 —— 四种"附加"的区别只有这里能说清(给模型看 / 抽文本 / 存盘 / 抓网页)。 */
  description?: string;
  onSelect: () => void;
  /** 在这一项之前画一条分隔线(附加类 ↔ 会话工具类)。 */
  separatorBefore?: boolean;
};

/** 菜单里的各项(按 DOM 顺序),方向键在它们之间移动焦点。 */
const menuItemsOf = (menu: HTMLDivElement | null): HTMLButtonElement[] =>
  Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);

type ComposerPlusMenuProps = {
  items: ComposerPlusMenuItem[];
  /** 「+」按钮的悬停文案。 */
  label: string;
};

/**
 * 输入框底栏的「+」菜单:添加附件 / 添加链接 / 检查点历史 / 全部命令等入口(由调用方传入)
 * 收在这里,每一项有名字和说明;底栏只留「+」、三个芯片和停止 / 发送,窄了也不折行。
 *
 * 菜单从按钮上方弹出(portal,固定定位,与档位 / Effort 下拉同一套做法),
 * 点外面 / Esc 关闭;选中一项即关闭。
 *
 * 键盘按菜单按钮的约定走:打开时焦点移到第一项,上下键(Home / End)在项间移动,
 * Esc / Tab 关闭并把焦点还给「+」;选中一项时焦点也先还给「+」,那一项要开弹窗的再自己挪走。
 */
export default function ComposerPlusMenu({ items, label }: ComposerPlusMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      left: rect.left,
      top: rect.top - 8,
      maxHeight: Math.max(120, rect.top - 16),
    });
  }, []);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updatePosition();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [open, updatePosition, closeAndRestoreFocus]);

  // 打开时焦点移进菜单(只在打开那一下;位置随滚动更新时不抢焦点)
  useEffect(() => {
    if (open) menuItemsOf(menuRef.current)[0]?.focus();
  }, [open]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = menuItemsOf(menuRef.current);
    if (entries.length === 0) return;
    if (event.key === 'Tab') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    const current = entries.indexOf(document.activeElement as HTMLButtonElement);
    const last = entries.length - 1;
    const next = event.key === 'ArrowDown'
      ? (current < 0 || current === last ? 0 : current + 1)
      : event.key === 'ArrowUp'
        ? (current <= 0 ? last : current - 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : -1;
    if (next < 0) return;
    event.preventDefault();
    entries[next].focus();
  };

  if (items.length === 0) return null;

  return (
    <>
      {/* 用原生 title 而不是共享的 Tooltip:菜单打开时自定义气泡会压在菜单角上,
          而 Tooltip 在"有内容 / 没内容"之间切换会重挂载按钮、ref 失效。 */}
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        title={label}
        onClick={() => {
          updatePosition();
          setOpen((current) => !current);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        data-composer-plus
        className={`h-8 w-8 rounded-full border border-border text-muted-foreground transition-transform hover:text-foreground [&_svg]:size-4 ${open ? 'rotate-45 border-border-strong text-foreground' : ''}`}
      >
        <Plus />
      </Button>

      {open && position && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          data-composer-plus-menu
          className="prism-modal-shadow fixed z-[100] w-72 overflow-y-auto rounded-panel border border-border bg-popover p-1"
          style={{
            left: position.left,
            top: position.top,
            maxHeight: position.maxHeight,
            transform: 'translateY(-100%)',
          }}
        >
          {items.map((item) => (
            <div key={item.id}>
              {item.separatorBefore && <div className="mx-2 my-1 h-px bg-border" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  closeAndRestoreFocus();
                  item.onSelect();
                }}
                className="flex w-full items-start gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
                  {item.icon}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-medium text-foreground">{item.label}</span>
                  {item.description && (
                    <span className="text-[11px] leading-snug text-muted-foreground">{item.description}</span>
                  )}
                </span>
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
