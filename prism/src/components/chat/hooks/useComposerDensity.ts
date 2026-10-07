import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

import { resolveComposerFooterLayout, type ComposerFooterLayout } from '../utils/composerDensity';

/**
 * 量底栏自己的宽度,换算成密度档和「转到后台」放不放得下(见 utils/composerDensity.ts)。
 *
 * 用 useLayoutEffect 而不是 useEffect:首帧就要拿到真实宽度,否则窄栏下会先按
 * full 画一帧再收缩 —— 那一下就是用户看到的"抖"。ResizeObserver 之后跟着
 * 容器变(拖预览栏、开关工作面板、最大化还原)。结果没变时不 setState,拖动时不白白重渲。
 */
export function useComposerDensity(footerRef: RefObject<HTMLElement | null>): ComposerFooterLayout {
  const [layout, setLayout] = useState<ComposerFooterLayout>(() => resolveComposerFooterLayout(0));

  useLayoutEffect(() => {
    const element = footerRef.current;
    if (!element) return;

    const measure = () => {
      const next = resolveComposerFooterLayout(element.clientWidth);
      setLayout((current) => (
        current.density === next.density && current.extraActionFits === next.extraActionFits ? current : next
      ));
    };

    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [footerRef]);

  return layout;
}
