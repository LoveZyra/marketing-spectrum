import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import type { ChatImage } from '../../types/types';

type ChatMessageImagesProps = {
  images: ChatImage[];
  projectId?: string | null;
};

/**
 * Resolves one chat image to a displayable src. Inline data URLs are used
 * directly; path-based attachments are fetched as blobs (a bare <img src>
 * cannot carry the auth header) — first from the global assets route
 * (`~/.cloudcli/assets`), then from the project files route as a fallback for
 * sessions recorded before attachments moved to the global store.
 */
function useChatImageSrc(
  image: ChatImage,
  projectId?: string | null,
  enabled: boolean = true,
): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(image.data || null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (image.data) {
      setSrc(image.data);
      setFailed(false);
      return;
    }

    // 还没滚到视野附近:不发请求,占位块先顶着。附件图取的是**原图** blob,
    // 长会话里几十张图在挂载瞬间全量并发拉取,既堵网络又白占内存 ——
    // 进入视口(带预读余量)再拉。
    if (!enabled) {
      return;
    }

    const imagePath = image.path;
    if (!imagePath) {
      setSrc(null);
      setFailed(true);
      return;
    }

    const filename = imagePath.split(/[\\/]/).pop() || '';
    const globalUrl = `/api/assets/images/${encodeURIComponent(filename)}`;
    const projectUrl = projectId
      ? `/api/projects/${projectId}/files/content?path=${encodeURIComponent(imagePath)}`
      : null;

    /**
     * 两条路都留着,但**先试哪条要看路径长什么样**。
     *
     * 新传的附件落在项目的 `attachments/` 下,历史里存的是绝对路径;
     * 早于这次改动传的图还在全局 `~/.prism/assets` 里,存的路径也在那儿。
     * 一律先试全局那条的话,每张项目内的图都要先白挨一个 404 —— 一屏十张图
     * 就是十个必然失败的请求。按路径里有没有 `attachments/` 分一下,
     * 命中的那条排前面,另一条仍然留作兜底(路径形态之外的意外情况)。
     */
    const looksProjectScoped = /[\\/]attachments[\\/]/.test(imagePath);
    const candidateUrls = (looksProjectScoped && projectUrl
      ? [projectUrl, globalUrl]
      : [globalUrl, projectUrl]
    ).filter((url): url is string => Boolean(url));

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      setFailed(false);
      for (const url of candidateUrls) {
        try {
          const response = await authenticatedFetch(url, { signal: controller.signal });
          if (!response.ok) {
            continue;
          }
          const blob = await response.blob();
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
          return;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return;
          }
        }
      }
      setSrc(null);
      setFailed(true);
    };

    void load();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [image.data, image.path, projectId, enabled]);

  return { src, failed };
}

/**
 * 元素滚进视口(带 rootMargin 预读余量)后置真,并保持为真。
 * 环境没有 IntersectionObserver(jsdom / 极老浏览器)时直接视为可见。
 */
function useNearViewport<T extends Element>(): { ref: (node: T | null) => void; visible: boolean } {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const observerRef = useRef<IntersectionObserver | null>(null);

  const ref = (node: T | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node || visible || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    observer.observe(node);
    observerRef.current = observer;
  };

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { ref, visible };
}

/**
 * Fullscreen image overlay in the claude.ai style: dark backdrop, centered
 * image, closes on backdrop click, close button, or Escape.
 */
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(16,16,16,0.72)]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image preview"
        className="absolute right-4 top-4 rounded-full border border-border bg-card p-2 text-card-foreground transition-colors hover:border-border-strong"
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
        className="prism-modal-shadow max-h-[90vh] max-w-[92vw] rounded-lg object-contain"
      />
    </div>,
    document.body,
  );
}

function ChatMessageImage({ image, projectId }: { image: ChatImage; projectId?: string | null }) {
  const { ref, visible } = useNearViewport<HTMLDivElement>();
  const { src, failed } = useChatImageSrc(image, projectId, visible);
  const [expanded, setExpanded] = useState(false);
  const alt = image.name || 'Attached image';

  if (failed) {
    return (
      <div className="flex h-28 w-28 items-center justify-center rounded-lg border border-border bg-muted px-2 text-center text-[10px] text-muted-foreground">
        {alt}
      </div>
    );
  }

  if (!src) {
    return <div ref={ref} className="h-28 w-28 rounded-lg border border-border bg-muted" />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={`Expand ${alt}`}
        className="block overflow-hidden rounded-lg border border-border focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="h-28 w-28 cursor-zoom-in object-cover"
        />
      </button>
      {expanded && <ImageLightbox src={src} alt={alt} onClose={() => setExpanded(false)} />}
    </>
  );
}

/**
 * Image attachments for a user turn, rendered claude.ai-style: standalone
 * rounded square cards shown above the message bubble. Each thumbnail
 * expands to a fullscreen lightbox on click.
 */
export default function ChatMessageImages({ images, projectId }: ChatMessageImagesProps) {
  if (!images || images.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {images.map((image, index) => (
        <ChatMessageImage key={image.path || image.name || index} image={image} projectId={projectId} />
      ))}
    </div>
  );
}
