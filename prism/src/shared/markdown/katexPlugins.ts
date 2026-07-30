import { useEffect, useMemo, useState } from 'react';
import type { Pluggable } from 'unified';

/**
 * KaTeX, loaded only for content that actually contains maths.
 *
 * `katex.mjs` is ~594 kB — after the syntax highlighter, the largest thing that
 * was in the entry chunk — and it was pulled in by two `remarkMath` /
 * `rehypeKatex` imports so that the small minority of messages containing `$x$`
 * would render. Now the plugins (and the stylesheet, which also drags font
 * files) are fetched the first time a message needs them, and the module-level
 * promise means every later message reuses that one fetch.
 */

type MathPlugins = { remarkMath: Pluggable; rehypeKatex: Pluggable };

let pending: Promise<MathPlugins> | null = null;
let loaded: MathPlugins | null = null;

export function loadKatexPlugins(): Promise<MathPlugins> {
  if (!pending) {
    pending = Promise.all([
      import('remark-math'),
      import('rehype-katex'),
      // The stylesheet is injected at runtime, which puts it after index.css in
      // the cascade — the same order the static import in main.jsx guaranteed.
      import('katex/dist/katex.min.css'),
    ]).then(([remark, rehype]) => {
      loaded = {
        remarkMath: remark.default as Pluggable,
        rehypeKatex: rehype.default as Pluggable,
      };
      return loaded;
    });
  }
  return pending;
}

// Fenced blocks and inline code are where `$` legitimately shows up in a
// developer tool (`$PATH`, `$ npm run dev`, jq filters). Stripping them first
// keeps shell snippets from dragging in half a megabyte of maths typesetting.
const CODE_SPANS = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

// remark-math's own rules, approximately: `$$…$$` anywhere, or a `$…$` pair on
// one line whose contents do not start or end with whitespace.
const MATH = /\$\$[\s\S]+?\$\$|\$(?![\s$])[^\n$]*[^\s$]\$/;

export function containsMath(source: string): boolean {
  if (!source.includes('$')) {
    return false;
  }
  return MATH.test(source.replace(CODE_SPANS, ''));
}

const NO_PLUGINS: Pluggable[] = [];

/**
 * Returns the maths plugins once they are needed and available, or empty
 * arrays. Re-rendering with the plugins in place is what makes the maths
 * appear, so the state update is the point rather than a side effect.
 */
export function useKatexPlugins(source: string): {
  remarkMathPlugins: Pluggable[];
  rehypeKatexPlugins: Pluggable[];
} {
  const needsMath = useMemo(() => containsMath(source), [source]);
  const [plugins, setPlugins] = useState<MathPlugins | null>(loaded);

  useEffect(() => {
    if (!needsMath || plugins) {
      return undefined;
    }

    let cancelled = false;
    void loadKatexPlugins().then((result) => {
      if (!cancelled) {
        setPlugins(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [needsMath, plugins]);

  return useMemo(() => {
    if (!needsMath || !plugins) {
      return { remarkMathPlugins: NO_PLUGINS, rehypeKatexPlugins: NO_PLUGINS };
    }
    return {
      remarkMathPlugins: [plugins.remarkMath],
      rehypeKatexPlugins: [plugins.rehypeKatex],
    };
  }, [needsMath, plugins]);
}
