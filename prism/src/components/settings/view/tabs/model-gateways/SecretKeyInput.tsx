import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';

/**
 * hq:填 key 的输入框。
 *
 * - `type="password"`、`autoComplete="new-password"`(复审:Chrome 对密码框无视 off,会把 Prism 的登录密码填进来 / 提示"保存密码"),再挂上常见密码管理器的忽略标记 —— 这里填的是网关 key,
 *   不是 Prism 的登录密码,不能让浏览器把登录密码自动填进来(那样会把登录密码当 key 存进库);
 * - 不预填:组件只认父级传进来的值,父级保存成功后把它清空;
 * - 显示 / 隐藏只影响本地显示,切回隐藏不会清掉已经填的值。
 */
type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  /** 按回车 —— 一般是「保存」 */
  onEnter?: () => void;
  className?: string;
};

export default function SecretKeyInput({ value, onChange, placeholder, ariaLabel, disabled, onEnter, className }: Props) {
  const { t } = useTranslation('settings');
  const [visible, setVisible] = useState(false);
  return (
    <span className={`relative block min-w-0 ${className ?? ''}`}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-bwignore="true"
        data-form-type="other"
        className="w-full rounded-md border border-input bg-transparent py-2 pl-3 pr-9 font-mono text-sm transition-colors focus:border-primary focus:outline-none disabled:opacity-50"
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? t('gateways.common.hideKey', { defaultValue: '隐藏 key' }) : t('gateways.common.showKey', { defaultValue: '显示 key' })}
        title={visible ? t('gateways.common.hideKey', { defaultValue: '隐藏 key' }) : t('gateways.common.showKey', { defaultValue: '显示 key' })}
        className="absolute inset-y-0 right-0 grid w-9 place-items-center text-muted-foreground hover:text-foreground"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </span>
  );
}
