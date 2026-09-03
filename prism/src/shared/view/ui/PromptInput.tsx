"use client";

import * as React from 'react';
import { SendHorizonalIcon, SquareIcon } from 'lucide-react';

import { cn } from '../../../lib/utils';

import { Button } from './Button';
import Tooltip from './Tooltip';

/* ─── Context ────────────────────────────────────────────────────── */

type PromptInputStatus = 'ready' | 'submitted' | 'streaming' | 'error';

interface PromptInputContextValue {
  status: PromptInputStatus;
}

const PromptInputContext = React.createContext<PromptInputContextValue | null>(null);

const usePromptInput = () => {
  const context = React.useContext(PromptInputContext);
  if (!context) {
    throw new Error('PromptInput components must be used within PromptInput');
  }
  return context;
};

/* ─── PromptInput (root form) ────────────────────────────────────── */

export interface PromptInputProps extends React.FormHTMLAttributes<HTMLFormElement> {
  status?: PromptInputStatus;
}

export const PromptInput = React.forwardRef<HTMLFormElement, PromptInputProps>(
  ({ className, status = 'ready', children, ...props }, ref) => {
    const contextValue = React.useMemo(() => ({ status }), [status]);

    return (
      <PromptInputContext.Provider value={contextValue}>
        <form
          ref={ref}
          data-slot="prompt-input"
          className={cn(
            // 只过渡聚焦相关的边框 —— **不要**用 transition-all,那会把 textarea
            // 自适应高度也做成动画,表现为"打字时输入框缓慢放大"。高度瞬时生效。
            // 输入框是这一屏的主角面板,**四角同一档圆角**(panel 档)。
            // ef:只留一层控件描边(input),不再 border + inset ring 叠两圈;
            // 聚焦时描边换成主色,这是全库输入框统一的三态(idle / hover / focus)。
            'relative overflow-hidden rounded-panel border border-input bg-card px-3.5 py-3 transition-[border-color] duration-[120ms] hover:border-border-strong focus-within:border-primary focus-within:hover:border-primary dark:border-primary/[0.16]',
            className
          )}
          {...props}
        >
          {children}
        </form>
      </PromptInputContext.Provider>
    );
  }
);
PromptInput.displayName = 'PromptInput';

/* ─── PromptInputHeader ──────────────────────────────────────────── */

export const PromptInputHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-header"
    className={cn('pb-3', className)}
    {...props}
  />
));
PromptInputHeader.displayName = 'PromptInputHeader';

/* ─── PromptInputBody ────────────────────────────────────────────── */

export const PromptInputBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-body"
    className={cn('relative', className)}
    {...props}
  />
));
PromptInputBody.displayName = 'PromptInputBody';

/* ─── PromptInputTextarea ────────────────────────────────────────── */

export const PromptInputTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="prompt-input-textarea"
    className={cn(
      'chat-input-placeholder block max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent p-0 text-sm leading-[22px] text-foreground placeholder-muted-foreground focus:outline-none sm:max-h-[300px]',
      className
    )}
    {...props}
  />
));
PromptInputTextarea.displayName = 'PromptInputTextarea';

/* ─── PromptInputFooter ──────────────────────────────────────────── */

export const PromptInputFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-footer"
    /**
     * ed:单行,永不换行。
     *
     * dw 曾允许换行兜底(工作面板一展开,六个附件图标 + 四个芯片的固有宽度就
     * 超了容器,不换行会把发送按钮裁掉)。用户要的是**最窄时也不折行**,所以
     * 这轮把根源拿掉:六个图标收进「+」菜单,三个芯片按底栏实测宽度分档收缩
     * (见 chat/utils/composerDensity.ts),最坏情况 220px 宽的底栏也放得下。
     * 这里回到 nowrap;万一将来有人往这行塞了新东西超出预算,被裁的是工具组
     * 的尾部(它有 overflow-hidden),发送按钮永远在右下角。
     */
    className={cn('flex flex-nowrap items-center gap-x-2.5 pt-3', className)}
    {...props}
  />
));
PromptInputFooter.displayName = 'PromptInputFooter';

/* ─── PromptInputTools ───────────────────────────────────────────── */

export const PromptInputTools = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="prompt-input-tools"
    /**
     * ed:占据剩余宽度、单行、超出即裁(见 PromptInputFooter 的说明)。
     * min-w-0 缺一个,flex 子项就按 min-content 撑着不收缩,右边的发送按钮必被顶出去。
     */
    // -my-1 py-1:裁剪盒上下各多 4px,聚焦环(ring-2)不会被裁掉;布局占位不变。
    className={cn('-my-1 flex min-w-0 flex-1 flex-nowrap items-center gap-x-1 overflow-hidden py-1', className)}
    {...props}
  />
));
PromptInputTools.displayName = 'PromptInputTools';

/* ─── PromptInputButton ──────────────────────────────────────────── */

export interface PromptInputButtonTooltip {
  content: React.ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export interface PromptInputButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip?: PromptInputButtonTooltip;
}

export const PromptInputButton = React.forwardRef<HTMLButtonElement, PromptInputButtonProps>(
  ({ className, tooltip, children, ...props }, ref) => {
    const button = (
      <Button
        ref={ref}
        type="button"
        variant="ghost"
        size="icon"
        className={cn('h-8 w-8 text-muted-foreground hover:text-foreground [&_svg]:size-4', className)}
        {...props}
      >
        {children}
      </Button>
    );

    if (tooltip) {
      return (
        <Tooltip
          content={
            tooltip.shortcut ? (
              <span className="flex items-center gap-1.5">
                {tooltip.content}
                <kbd className="rounded-sm border border-border px-1 font-mono text-[10px]">{tooltip.shortcut}</kbd>
              </span>
            ) : (
              tooltip.content
            )
          }
          position={tooltip.side ?? 'top'}
        >
          {button}
        </Tooltip>
      );
    }

    return button;
  }
);
PromptInputButton.displayName = 'PromptInputButton';

/* ─── PromptInputSubmit ──────────────────────────────────────────── */

export interface PromptInputSubmitProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  status?: PromptInputStatus;
}

export const PromptInputSubmit = React.forwardRef<HTMLButtonElement, PromptInputSubmitProps>(
  ({ className, status: statusProp, children, ...props }, ref) => {
    const context = React.useContext(PromptInputContext);
    const status = statusProp ?? context?.status ?? 'ready';
    const isActive = status === 'submitted' || status === 'streaming';

    return (
      <Button
        ref={ref}
        type={isActive ? 'button' : 'submit'}
        variant="default"
        size="icon"
        className={cn(
          // 设计稿:发送是带文字的 primary 按钮,6px 14px / 13px / 600
          'h-8 shrink-0 rounded-md px-3.5 text-[13px] font-semibold',
          className,
        )}
        {...props}
      >
        {children ?? (isActive ? (
          <SquareIcon className="h-3.5 w-3.5 fill-current" />
        ) : (
          <SendHorizonalIcon className="h-4 w-4" />
        ))}
      </Button>
    );
  }
);
PromptInputSubmit.displayName = 'PromptInputSubmit';

export { usePromptInput };
