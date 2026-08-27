import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { SessionExportFormat } from '../../utils/session-export';

type Props = {
  /** 触发按钮(导出图标)。菜单挂在它下面。 */
  children: (props: { onClick: (event: React.MouseEvent) => void; ref: React.Ref<HTMLButtonElement> }) => React.ReactNode;
  onExport: (options: { format: SessionExportFormat; includeTools: boolean }) => void;
};

const FORMATS: Array<{ value: SessionExportFormat; labelKey: string; fallback: string; hintKey: string; hintFallback: string }> = [
  { value: 'md', labelKey: 'export.md', fallback: 'Markdown', hintKey: 'export.mdHint', hintFallback: '给人读、贴进文档' },
  { value: 'html', labelKey: 'export.html', fallback: 'HTML', hintKey: 'export.htmlHint', hintFallback: '独立网页,双击即看' },
  { value: 'json', labelKey: 'export.json', fallback: 'JSON', hintKey: 'export.jsonHint', hintFallback: '给程序读、二次加工' },
];

/**
 * 导出格式选单(F12)。
 *
 * 导出按钮原来是"点了就下 Markdown"。加了 JSON 与「含工具过程」之后,再把它藏进
 * 一个固定行为里就说不过去了 —— 但也不该为此弹出一个模态框:选个格式而已。
 * 一枚贴着按钮的小面板,三个格式 + 一个开关,点哪个下哪个。
 *
 * 面板 portal 到 body:侧栏那颗按钮在 overflow-hidden 的滚动容器里,不 portal 会被裁掉。
 */
export default function SessionExportMenu({ children, onExport }: Props) {
  const { t } = useTranslation('common');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null);
  const [includeTools, setIncludeTools] = useState(false);

  useEffect(() => {
    if (!rect) return;
    const close = () => setRect(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [rect]);

  const open = (event: React.MouseEvent) => {
    event.stopPropagation();
    const box = triggerRef.current?.getBoundingClientRect();
    if (!box) return;
    const width = 232;
    setRect({
      left: Math.min(box.left, Math.max(8, window.innerWidth - 8 - width)),
      top: box.bottom + 4,
    });
  };

  return (
    <>
      {children({ onClick: open, ref: triggerRef })}
      {rect && createPortal(
        <>
          <div className="fixed inset-0 z-[100]" onClick={() => setRect(null)} />
          <div
            role="menu"
            className="prism-modal-shadow fixed z-[101] w-[232px] overflow-hidden rounded-lg border border-border bg-popover py-1"
            style={{ left: rect.left, top: rect.top }}
          >
            {FORMATS.map((format) => (
              <button
                key={format.value}
                type="button"
                role="menuitem"
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-accent"
                onClick={(event) => {
                  event.stopPropagation();
                  setRect(null);
                  onExport({ format: format.value, includeTools });
                }}
              >
                <span className="text-sm text-foreground">{t(format.labelKey, { defaultValue: format.fallback })}</span>
                <span className="text-[11px] text-muted-foreground">{t(format.hintKey, { defaultValue: format.hintFallback })}</span>
              </button>
            ))}
            <label
              className="mt-1 flex cursor-pointer items-center gap-2 border-t border-border px-3 py-2 text-xs text-body hover:bg-accent"
              onClick={(event) => event.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={includeTools}
                onChange={(event) => setIncludeTools(event.target.checked)}
                className="h-3.5 w-3.5"
              />
              {t('export.includeTools', { defaultValue: '含工具过程' })}
            </label>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
