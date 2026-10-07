import { useEffect, useRef, type RefObject } from 'react';

import { isLocalEscapeTarget, isTopModal, pushModal, removeModal } from './modalStack';

/**
 * 自建弹层的键盘行为:Esc 关闭 + Tab 焦点陷阱 + 打开时锁 body 滚动。
 *
 * ## 为什么会有这个 hook
 *
 * 共用的 `<Dialog>` 早就把这三件事做对了。但仓库里还有三处自己糊的弹层
 * (定时任务表单、图片查看器、检查点面板),它们只写了
 * `role="dialog" aria-modal="true"` —— 声明了自己是模态,却没有模态该有的行为。
 *
 * 对键盘用户这不是"不够好",是出不来:Tab 会一路跑到弹层背后的页面上去,
 * 而 Esc 没人接。定时任务那个还是多字段表单,尤其难受。
 * `aria-modal="true"` 同时告诉读屏软件"背后的内容不存在" —— 焦点真跑出去了,
 * 用户会听到一片它以为不存在的东西。
 *
 * ## 为什么不直接把那三处迁到 `<Dialog>`
 *
 * 三处各有各的版式(右侧抽屉、全屏图片、居中表单),迁移要动布局,风险远大于收益。
 * 把行为抽出来共用、版式各自保留,是这里更划算的切法。
 *
 * 判据只有一份,以后再有第四个自建弹层直接接上就行 —— 而不是又抄一遍。
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalKeyboard(
  containerRef: RefObject<HTMLElement | null>,
  options: { open?: boolean; onClose: () => void; lockScroll?: boolean },
): void {
  const { open = true, onClose, lockScroll = true } = options;
  // onClose 走 ref:调用方常传内联函数,放进依赖会让 effect 每次渲染都重跑 ——
  // 而重跑 = 出栈再入栈,父弹层一重渲染就会跑到已打开的子弹层上面去。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    // 入栈;只有栈顶这一层处理键盘(见 modalStack.ts)。
    const modalId = pushModal();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isTopModal(modalId)) return;
      if (event.key === 'Escape') {
        // 行内输入框(改名 / 重置密码 / 额度编辑)自己的 Esc 优先:取消输入,不关弹窗。
        if (isLocalEscapeTarget(event.target)) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;

      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        // 隐藏元素拿不到焦点,算进来会让 first/last 指到错的地方
        .filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // 焦点还在弹层外面(比如刚打开还没落焦):抓回来
      if (!container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // capture 阶段:弹层内部的输入框可能自己 stopPropagation,冒泡阶段就收不到了
    document.addEventListener('keydown', handleKeyDown, true);

    const previousOverflow = lockScroll ? document.body.style.overflow : null;
    if (lockScroll) document.body.style.overflow = 'hidden';

    return () => {
      removeModal(modalId);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (lockScroll && previousOverflow !== null) document.body.style.overflow = previousOverflow;
    };
  }, [open, containerRef, lockScroll]);
}
