import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff, X } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { useModalKeyboard } from '../../../shared/view/hooks/useModalKeyboard';
import { authenticatedFetch } from '../../../utils/api';
import type { FileTreeImageSelection } from '../types/types';

type ImageViewerProps = {
  file: FileTreeImageSelection;
  onClose: () => void;
};

export default function ImageViewer({ file, onClose }: ImageViewerProps) {
  const { t } = useTranslation('common');
  const imagePath = `/api/projects/${file.projectId}/files/content?path=${encodeURIComponent(file.path)}`;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // hl(P3 文件组):坏图片(扩展名是 png、内容不是)以前既不报错也不显示 —— 一块空白。
  const [decodeFailed, setDecodeFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // hl(P3 文件组):Esc 关不掉、Tab 跑到背后 —— 接上共用的模态键盘行为。
  useModalKeyboard(containerRef, { onClose });
  useEffect(() => { closeButtonRef.current?.focus(); }, []);

  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();

    const loadImage = async () => {
      try {
        setLoading(true);
        setError(null);
        setImageUrl(null);
        setDecodeFailed(false);

        const response = await authenticatedFetch(imagePath, {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }

        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (loadError: unknown) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return;
        }
        console.error('Error loading image:', loadError);
        setError(t('imageViewer.loadFailed', { defaultValue: '图片加载失败' }));
      } finally {
        setLoading(false);
      }
    };

    loadImage();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [imagePath, t]);

  const showImage = !loading && imageUrl && !decodeFailed;
  const failureText = decodeFailed
    ? t('imageViewer.cannotDisplay', { defaultValue: '无法显示:这个文件不是有效的图片,或已损坏' })
    : (error || t('imageViewer.loadFailed', { defaultValue: '图片加载失败' }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,16,16,0.72)]"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={file.name}
        onClick={(event) => event.stopPropagation()}
        className="prism-modal-shadow mx-4 max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-lg bg-background"
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="truncate text-lg font-semibold text-foreground">{file.name}</h3>
          <Button
            ref={closeButtonRef}
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 shrink-0 p-0"
            aria-label={t('actions.close', { defaultValue: '关闭' })}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-[400px] items-center justify-center bg-muted p-4">
          {loading && (
            <div className="text-center text-muted-foreground">
              <p>{t('imageViewer.loading')}</p>
            </div>
          )}
          {showImage && (
            <img
              src={imageUrl}
              alt={file.name}
              onError={() => setDecodeFailed(true)}
              className="max-h-[70vh] max-w-full rounded-lg object-contain"
            />
          )}
          {!loading && (!imageUrl || decodeFailed) && (
            <div className="text-center text-muted-foreground" role="alert">
              <ImageOff className="mx-auto mb-2 h-6 w-6" aria-hidden="true" />
              <p>{failureText}</p>
              <p className="mt-2 break-all text-sm">{file.path}</p>
            </div>
          )}
        </div>

        <div className="border-t border-border bg-muted p-4">
          <p className="font-mono text-sm text-body">{file.path}</p>
        </div>
      </div>
    </div>
  );
}
