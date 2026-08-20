import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { ClampedBlock } from '../../../../../shared/view/ui';
import { toParamRows } from '../../../utils/detailsFormatting';

import { JsonView } from './JsonView';

interface ParamsTableProps {
  /** 已解析的工具入参(字符串 / 标量也接受) */
  input: unknown;
}

/**
 * 工具参数:键值表,而不是一整块 JSON。
 *
 * 短标量排在键右边一行看完;多行文本与对象 / 数组落到键下面的块里,
 * 超高自动折叠。看参数的人要找的是"这次动的是哪个文件 / 哪条命令",
 * 不是欣赏一段缩排。
 */
export const ParamsTable: React.FC<ParamsTableProps> = ({ input }) => {
  const { t } = useTranslation('chat');
  const rows = useMemo(() => toParamRows(input), [input]);

  if (rows.length === 0) {
    return (
      <div className="font-mono text-[11px] text-muted-foreground">
        {t('details.noParams', { defaultValue: '无参数' })}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {rows.map((row, index) => (
        row.inline !== undefined ? (
          // 短标量:键在左、值在右,一行看完
          <div key={`${row.key}-${index}`} className="flex min-w-0 items-baseline gap-2.5">
            {row.key && (
              <span className="w-24 flex-none truncate text-right font-mono text-[11px] leading-[17px] text-muted-foreground" title={row.key}>
                {row.key}
              </span>
            )}
            <span className="min-w-0 flex-1 break-all font-mono text-[11.5px] leading-[17px] text-code" title={row.inline}>
              {row.inline}
            </span>
          </div>
        ) : row.block ? (
          // 代码块 / 长文本:键提到块上面一行,块占满整行左对齐 ——
          // 键在左、块在右那种排法,块的左边界会和上下所有内容错开,看着就是没对齐。
          <div key={`${row.key}-${index}`} className="min-w-0">
            {row.key && (
              <div className="mb-1 font-mono text-[11px] leading-[17px] text-muted-foreground">{row.key}</div>
            )}
            <ClampedBlock
              maxHeight={200}
              lineCount={row.block.lines > 1 ? row.block.lines : undefined}
              copyText={row.block.text}
              contentClassName="rounded-md border border-border bg-card px-3 py-2"
            >
              {row.block.isJson
                ? <JsonView text={row.block.text} />
                : (
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px] text-code">
                    {row.block.text}
                  </pre>
                )}
            </ClampedBlock>
          </div>
        ) : null
      ))}
    </div>
  );
};
