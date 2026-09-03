import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
  /** 在这一项**之前**画一条分隔线(附加类 ↔ 会话工具类)。 */
  separatorBefore?: boolean;
};

type ComposerPlusMenuProps = {
  items: ComposerPlusMenuItem[];
  /** 「+」按钮的悬停文案。 */
  label: string;
};

/**
 * ed:底栏的「+」—— 参考 Cowork 的输入框,把六个并排的小图标(任意文件 / 图片 /
 * 文档 / 链接 / 检查点历史 / 全部命令)收进一个菜单。
 *
 * 为什么不是"删掉几个":四个附加入口走的是**四条不同的路**(图片给模型看、
 * 文档抽正文、任意文件存进项目交给智能体、链接抓网页正文),合并成一个"上传"
 * 会丢掉这个区别;但它们并排摆六个图标,每个都只有 hover 才知道是什么,
 * 而且把底栏的宽度吃光 —— 芯片一多就折行。收进菜单后每一项有名字有说明,
 * 底栏只剩「+」+ 三个芯片 + 发送。
 *
 * 菜单从按钮上方弹出(portal,固定定位,与档位 / Effort 下拉同一套做法),
 * 点外面 / Esc 关闭;选中一项即关闭。
 */
export default function ComposerPlusMenu({ items, label }: ComposerPlusMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

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
        setOpen(false);
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
  }, [open, updatePosition]);

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
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
                className="flex w-full items-start gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent"
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
