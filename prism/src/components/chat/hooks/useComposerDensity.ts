import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

import { resolveComposerDensity, type ComposerDensity } from '../utils/composerDensity';

/**
 * ed:量底栏自己的宽度,换算成密度档(见 utils/composerDensity.ts)。
 *
 * 用 useLayoutEffect 而不是 useEffect:首帧就要拿到真实宽度,否则窄栏下会先按
 * full 画一帧再收缩 —— 那一下就是用户看到的"抖"。ResizeObserver 之后跟着
 * 容器变(拖预览栏、开关工作面板、最大化还原)。
 */
export function useComposerDensity(footerRef: RefObject<HTMLElement | null>): ComposerDensity {
  const [density, setDensity] = useState<ComposerDensity>('full');

  useLayoutEffect(() => {
    const element = footerRef.current;
    if (!element) return;

    const measure = () => {
      const next = resolveComposerDensity(element.clientWidth);
      setDensity((current) => (current === next ? current : next));
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

  return density;
}
