import React, { useMemo } from 'react';

import { cn } from '../../../../../lib/utils';
import { tokenizeJson, type JsonTokenKind } from '../../../utils/detailsFormatting';

const TOKEN_CLASS: Record<JsonTokenKind, string> = {
  // 键弱化、字符串走代码墨色、数字与 true/false/null 用强调色
  // (淡色模式下绿色不做小字,所以强调色在浅底上退回墨色)
  key: 'text-muted-foreground',
  string: 'text-code',
  literal: 'text-card-foreground dark:text-primary',
  plain: 'text-muted-foreground',
};

interface JsonViewProps {
  /** 已缩排好的 JSON 文本 */
  text: string;
  className?: string;
}

/**
 * JSON 着色 —— 只分三档(键 / 字符串 / 字面量),不做彩虹高亮:
 * 设计系统只有一个强调色,颜色在这里是用来分层的,不是用来装饰的。
 */
/**
 * fj:超过这个体量就不着色了 —— 直接一段纯文本。
 *
 * 每个 token 一个 `<span>`,原来没有任何上限:一条返回大 JSON 的 MCP 工具
 * (而 `Default.result.defaultOpen` 是 true,所有未知工具的返回**默认全量挂载**)
 * 一次点击就生成几万个 DOM 节点,主线程冻住数秒。着色是锦上添花,不值这个价。
 */
const MAX_COLORIZED_CHARS = 20_000;

export const JsonView: React.FC<JsonViewProps> = ({ text, className }) => {
  const tooLargeToColorize = text.length > MAX_COLORIZED_CHARS;
  const tokens = useMemo(
    () => (tooLargeToColorize ? [] : tokenizeJson(text)),
    [text, tooLargeToColorize],
  );

  return (
    <pre className={cn('overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px]', className)}>
      {tooLargeToColorize
        ? text
        : tokens.map((token, index) => (
          <span key={index} className={TOKEN_CLASS[token.kind]}>{token.text}</span>
        ))}
    </pre>
  );
};
