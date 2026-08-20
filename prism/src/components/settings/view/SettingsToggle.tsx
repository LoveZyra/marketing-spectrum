import { cn } from '../../../lib/utils';

type SettingsToggleProps = {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
};

export default function SettingsToggle({ checked, onChange, ariaLabel, disabled }: SettingsToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 flex-shrink-0 touch-manipulation cursor-pointer items-center rounded-full border-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        checked ? 'border-primary bg-primary' : 'border-border bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      {/* 滑块的位移是静态的 —— 设计系统只允许颜色/描边/阴影/透明度参与过渡 */}
      <span
        className={cn(
          'pointer-events-none inline-block h-5 w-5 rounded-full transition-colors',
          checked ? 'translate-x-[22px] bg-primary-foreground' : 'translate-x-[2px] bg-muted-foreground',
        )}
      />
    </button>
  );
}
