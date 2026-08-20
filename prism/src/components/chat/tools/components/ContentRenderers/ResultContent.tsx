import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { ClampedBlock } from '../../../../../shared/view/ui';
import { detectResultShape } from '../../../utils/detailsFormatting';

import { JsonView } from './JsonView';

interface ResultContentProps {
  content: unknown;
  isError?: boolean;
}

/**
 * 工具返回:按形态分型,不是一律铺成文字。
 *
 * - 空 → 一行「无输出」,不给空盒子
 * - 能解析的 JSON → 缩排 + 三档着色
 * - 一句话 → 就一行,不套框(`Cancelled job 15082b3a` 这种)
 * - 其余 → 等宽块,超高折叠,右上角悬停出复制
 *
 * 失败不用红色(设计系统里红只留给不可逆销毁),靠「失败」二字与弱化描边表达。
 */
export const ResultContent: React.FC<ResultContentProps> = ({ content, isError }) => {
  const { t } = useTranslation('chat');
  const shape = useMemo(() => detectResultShape(content), [content]);

  if (shape.kind === 'empty') {
    return (
      <div className="font-mono text-[11px] text-muted-foreground">
        {isError
          ? t('details.failedNoOutput', { defaultValue: '失败 · 无输出' })
          : t('details.noOutput', { defaultValue: '无输出' })}
      </div>
    );
  }

  if (shape.kind === 'line') {
    return (
      <div className="flex min-w-0 items-baseline gap-2">
        {isError && (
          <span className="flex-none font-mono text-[11px] text-muted-foreground">
            {t('details.failed', { defaultValue: '失败' })}
          </span>
        )}
        <span className="min-w-0 flex-1 break-all font-mono text-[11.5px] leading-[17px] text-code">
          {shape.text}
        </span>
      </div>
    );
  }

  return (
    <ClampedBlock
      maxHeight={220}
      lineCount={shape.lines}
      copyText={shape.text}
      contentClassName="rounded-md border border-border bg-card px-3 py-2.5"
    >
      {shape.kind === 'json'
        ? <JsonView text={shape.text} />
        : (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-code">
            {shape.text}
          </pre>
        )}
    </ClampedBlock>
  );
};
