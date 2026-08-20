import { useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Shimmer } from '../../../../shared/view/ui';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';

type ActivityIndicatorProps = {
  activity: SessionActivity | null;
};

const ACTION_KEYS = [
  'claudeStatus.actions.thinking',
  'claudeStatus.actions.processing',
  'claudeStatus.actions.analyzing',
  'claudeStatus.actions.working',
  'claudeStatus.actions.computing',
  'claudeStatus.actions.reasoning',
];
const DEFAULT_ACTION_WORDS = ['Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning'];
const EXIT_ANIMATION_MS = 220;

/** 12 颗点摆成一圈 —— 静态,不转。"还在跑"由右边的耗时数字在跳来表达。 */
const RING_DOTS = Array.from({ length: 12 }, (_, index) => {
  const angle = (index / 12) * Math.PI * 2 - Math.PI / 2;
  return {
    cx: 9 + Math.cos(angle) * 6.5,
    cy: 9 + Math.sin(angle) * 6.5,
    // 顺时针渐隐,读起来有方向感,但没有任何动画
    opacity: 0.25 + (index / 12) * 0.75,
  };
});

/**
 * 运行中指示器 —— 站在消息流的末尾,不再贴在输入框上沿。
 *
 * 原来它是两片贴着输入框上边缘的"标签页",一跑起来输入框的形状就跟着变;
 * 现在它就是对话流里的最后一行:点圈 + 正在做什么 + 耗时。
 * 中止按钮搬去了输入框右下角(和发送同一处),那里才是动作该在的地方。
 */
export default function ActivityIndicator({ activity }: ActivityIndicatorProps) {
  const { t } = useTranslation('chat');
  const [renderedActivity, setRenderedActivity] = useState<SessionActivity | null>(activity);
  const [isExiting, setIsExiting] = useState(false);
  const startedAt = renderedActivity?.startedAt ?? null;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (activity) {
      setRenderedActivity(activity);
      setIsExiting(false);
      return;
    }

    if (!renderedActivity) return;

    setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, EXIT_ANIMATION_MS);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!renderedActivity) return null;

  const actionWords = ACTION_KEYS.map((key, i) => t(key, { defaultValue: DEFAULT_ACTION_WORDS[i] }));
  /**
   * 压缩上下文单独成一档。
   *
   * 服务端那条状态的原文是英文("Compacting context…" / "Context at 82% —
   * compacting before sending…"),直接摆到界面上既不通顺也不跟随语言设置。
   * 所以服务端只发 `statusKind: 'compacting'`,文案在这里本地化;
   * 图标也从"正在思考"的点圈换成归档图标 —— 压缩不是在想事情,是在收拾行李。
   */
  const isCompacting = renderedActivity.statusKind === 'compacting';
  const label = isCompacting
    ? t('claudeStatus.compacting', { defaultValue: '正在压缩上下文' })
    : (renderedActivity.statusText || actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length])
      .replace(/\.+$/, '');

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });

  return (
    <div
      className={`chat-message tool relative flex items-center gap-2.5 px-3 sm:px-0 ${
        isExiting ? 'chat-activity-exit' : 'chat-activity-enter'
      }`}
      role="status"
      aria-live="polite"
    >
      {/* 扫描线:一道极淡的强调色高光从左扫到右,只在深色主场出现。
          纯 background-position 动画,不参与布局,也不碰文字。 */}
      <span
        className="prism-scan pointer-events-none absolute inset-y-0 left-0 w-64 max-w-full rounded-sm"
        aria-hidden
      />

      {isCompacting ? (
        <Archive className="relative h-[18px] w-[18px] flex-none text-primary" strokeWidth={2} aria-hidden />
      ) : (
        <svg className="relative h-[18px] w-[18px] flex-none" viewBox="0 0 18 18" aria-hidden>
          {RING_DOTS.map((dot, index) => (
            <circle key={index} cx={dot.cx} cy={dot.cy} r="1.4" className="fill-primary" opacity={dot.opacity} />
          ))}
        </svg>
      )}

      <Shimmer className="relative text-[13px] leading-5">{`${label}…`}</Shimmer>
      <span className="relative font-mono text-[11px] tabular-nums text-muted-foreground">{elapsedLabel}</span>
    </div>
  );
}
