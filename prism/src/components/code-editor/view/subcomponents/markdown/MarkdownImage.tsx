import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';

import { authenticatedFetch } from '../../../../../utils/api';

import { resolveMarkdownImagePath } from './markdownImagePath';

export type MarkdownImageBase = {
  projectId?: string | null;
  /** 这份 markdown 相对项目根的路径;项目外的文件为 null(相对图片无从解析)。 */
  relPath?: string | null;
};

type Props = {
  src?: string;
  alt?: string;
  title?: string;
  base: MarkdownImageBase;
};

export default function MarkdownImage({ src, alt, title, base }: Props) {
  const relative = src && base.relPath != null ? resolveMarkdownImagePath(src, base.relPath) : null;
  const passthrough = !relative;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (passthrough || !base.projectId || !relative) return undefined;
    let url: string | null = null;
    const controller = new AbortController();
    setFailed(false);
    setObjectUrl(null);
    (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/projects/${encodeURIComponent(base.projectId!)}/files/content?path=${encodeURIComponent(relative)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setFailed(true);
      }
    })();
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [passthrough, base.projectId, relative]);

  if (passthrough) {
    // 外链或无法按项目解析(项目外的文件):交给浏览器,坏了也给个说法而不是裂图。
    return failed ? (
      <span className="not-prose inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
        <ImageOff className="h-3.5 w-3.5" aria-hidden="true" />
        无法显示:{src}
      </span>
    ) : (
      <img src={src} alt={alt} title={title} onError={() => setFailed(true)} />
    );
  }

  if (failed) {
    return (
      <span className="not-prose inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
        <ImageOff className="h-3.5 w-3.5" aria-hidden="true" />
        无法显示:{relative}
      </span>
    );
  }

  if (!objectUrl) {
    return <span className="inline-block h-4 w-24 animate-pulse rounded bg-muted" aria-label={alt || relative} />;
  }

  return <img src={objectUrl} alt={alt} title={title} onError={() => setFailed(true)} />;
}
