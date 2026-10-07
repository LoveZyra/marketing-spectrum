import * as React from 'react';

import { commitNumber, parseTyping, stepNumber, type NumberRule } from './numberInput';

/**
 * 能正常打字的数字输入框。规则见 `numberInput.ts`:打字时不改写你的文字,离开时才夹到范围里。
 *
 * `value` 是上层保存的数(`null` = 空、用 placeholder 的默认值);`onChange` 在打字过程中收到
 * 读得出的数(未夹取),离开时收到最终夹取后的数。外面改了 `value`(比如切换 skill 重置表单)
 * 且输入框不在输入中时,文字跟着变。
 */
type NumberInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & NumberRule & {
  value: number | null;
  onChange: (value: number | null) => void;
};

const toText = (value: number | null) => (value === null || Number.isNaN(value) ? '' : String(value));

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onChange, min, max, integer, allowEmpty, fallback, onBlur, onFocus, onKeyDown, step, placeholder, ...rest }, ref) => {
    const [text, setText] = React.useState(() => toText(value));
    const editing = React.useRef(false);

    React.useEffect(() => {
      if (!editing.current) setText(toText(value));
    }, [value]);

    return (
      <input
        {...rest}
        ref={ref}
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        autoComplete="off"
        value={text}
        placeholder={placeholder}
        // 行为是 spinbutton(↑/↓ 步进、有上下限),声明出来并带上当前值;
        // aria-valuemin/max 挂在默认的 textbox 角色上是无效属性。
        role="spinbutton"
        aria-valuenow={value ?? undefined}
        aria-valuetext={value === null ? placeholder : undefined}
        aria-valuemin={min}
        aria-valuemax={max}
        onFocus={(event) => { editing.current = true; onFocus?.(event); }}
        onKeyDown={(event) => {
          // 上下方向键按 step 加减(type="text" 没有原生的小箭头)
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const delta = (Number(step) || 1) * (event.key === 'ArrowUp' ? 1 : -1);
            // 空框从 placeholder 显示的默认值起步。
            const done = stepNumber(text, value, delta, { min, max, integer, fallback, placeholder });
            setText(done.text);
            onChange(done.value);
          }
          onKeyDown?.(event);
        }}
        onChange={(event) => {
          const next = event.target.value;
          // 只收数字相关的字符;其余按键直接不进(不会出现 "1a")
          if (next !== '' && !/^-?\d*\.?\d*$/.test(next.trim())) return;
          if (integer && next.includes('.')) return;
          if ((min ?? 0) >= 0 && next.includes('-')) return;
          setText(next);
          const n = parseTyping(next);
          if (n !== null) onChange(n);
          else if (next.trim() === '' && allowEmpty) onChange(null);
        }}
        onBlur={(event) => {
          editing.current = false;
          const done = commitNumber(text, { min, max, integer, allowEmpty, fallback });
          setText(done.text);
          if (done.value !== value) onChange(done.value);
          onBlur?.(event);
        }}
      />
    );
  },
);

NumberInput.displayName = 'NumberInput';
