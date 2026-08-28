import { useEffect, useRef, useState } from 'react';
import { Archive, AlertTriangle, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Shimmer } from '../../../../shared/view/ui';
import {
  COMPACTION_RESULT_LINGER_MS,
  compactionTone,
  isTerminalCompactionPhase,
  formatDuration,
  formatTokens,
  freedRatio,
} from '../../utils/compactionProgress';
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

    // 压缩的结果行(218K → 46K · 38s)必须比退场动画活得久:压缩跑在
    // `complete` 之前,结果帧刚到、下一帧 complete 就把 activity 清空了。
    // 按 220ms 退场等于没显示过。
    const finishedCompaction = isTerminalCompactionPhase(renderedActivity.compaction?.phase);
    const holdMs = finishedCompaction ? COMPACTION_RESULT_LINGER_MS : EXIT_ANIMATION_MS;

    if (!finishedCompaction) setIsExiting(true);
    const timer = setTimeout(() => {
      setRenderedActivity(null);
      setIsExiting(false);
    }, holdMs);

    return () => clearTimeout(timer);
  }, [activity, renderedActivity]);

  useEffect(() => {
    if (startedAt === null) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  /**
   * 压缩自己的计时,和回合的耗时分开 —— 维护窗口的压缩发生在回合**答完之后**,
   * 拿 `startedAt`(回合开始)去算,一上来就是"已经 8 分钟",毫无意义。
   */
  const compaction = renderedActivity?.compaction ?? null;
  const compactionPhase = compaction?.phase ?? null;
  const compactionBeat = compaction?.beat ?? null;
  const compactionServerElapsed = compaction?.elapsedMs ?? 0;
  /** 最近一帧的服务端耗时 + 它到达的本地时刻 —— 两帧之间靠本地时钟插值走秒。 */
  const elapsedAnchorRef = useRef<{ serverMs: number; atMs: number }>({ serverMs: 0, atMs: 0 });
  const lastBeatAtRef = useRef<number>(0);
  const [compactionElapsedMs, setCompactionElapsedMs] = useState(0);

  if (compactionPhase !== 'running' && lastBeatAtRef.current !== 0) {
    lastBeatAtRef.current = 0;
  }

  // 心跳只在 CLI 真的往流里推东西时才递增 —— 记下它到达的时刻,
  // 停跳超过阈值就把"可能卡住了"说出来(定时动画做不到这件事)。
  // 同一帧带来的服务端耗时也在这里落锚。
  useEffect(() => {
    if (compactionPhase !== 'running') return;
    lastBeatAtRef.current = Date.now();
    elapsedAnchorRef.current = { serverMs: compactionServerElapsed, atMs: Date.now() };
  }, [compactionPhase, compactionBeat, compactionServerElapsed]);

  /**
   * 终态自己也会过期。
   *
   * 回合**结束**时靠上面那段滞留(activity 变 null 后多留 LINGER)。但 CLI 原生
   * 压缩是压完**继续答这一轮**的 —— 那条路上 activity 一直活着,没有任何帧会来
   * 覆盖压缩状态,结果行就会一路挂在正文下面直到回合结束。这里给终态自己上一个
   * 计时器,时间一到退回普通指示器。
   */
  const [resultExpired, setResultExpired] = useState(false);
  useEffect(() => {
    if (!isTerminalCompactionPhase(compactionPhase)) {
      setResultExpired(false);
      return;
    }
    setResultExpired(false);
    const timer = setTimeout(() => setResultExpired(true), COMPACTION_RESULT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [compactionPhase, compaction?.durationMs, compaction?.skipReason]);

  useEffect(() => {
    if (compactionPhase !== 'running') {
      setCompactionElapsedMs(0);
      return;
    }
    const update = () => {
      const anchor = elapsedAnchorRef.current;
      setCompactionElapsedMs(Math.max(0, anchor.serverMs + (Date.now() - anchor.atMs)));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [compactionPhase]);

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
  const isCompacting = renderedActivity.statusKind === 'compacting' && !resultExpired;

  /**
   * 压缩没有"完成度"可言,所以这里给的是**阶段 + 时间 + 心跳**,不是百分比。
   * tone 由纯函数算(见 compactionProgress),组件只负责画。
   */
  const tone = compaction && !resultExpired
    ? compactionTone(compaction, compactionElapsedMs, lastBeatAtRef.current, Date.now())
    : null;

  const freed = compaction ? freedRatio(compaction.preTokens, compaction.postTokens) : null;
  const compactionLabel = (() => {
    if (!compaction) return t('claudeStatus.compacting', { defaultValue: '正在压缩上下文' });
    if (tone === 'done') {
      // 有 pre/post 就报硬数据;CLI 没给全就只说压完了 —— 不编。
      if (compaction.preTokens && compaction.postTokens) {
        return t('claudeStatus.compaction.doneWithNumbers', {
          before: formatTokens(compaction.preTokens),
          after: formatTokens(compaction.postTokens),
          percent: freed === null ? '' : Math.round(freed * 100),
          defaultValue: '已压缩 {{before}} → {{after}},释放 {{percent}}%',
        });
      }
      return t('claudeStatus.compaction.done', { defaultValue: '上下文已压缩' });
    }
    if (tone === 'failed') {
      return t('claudeStatus.compaction.failed', { defaultValue: '压缩失败,下一轮将带着未压缩的上下文继续' });
    }
    if (tone === 'skipped') {
      // 「没压」不是「压失败」:对话太短本来就没什么可压,中止是用户自己按的。
      return compaction.skipReason === 'aborted'
        ? t('claudeStatus.compaction.aborted', { defaultValue: '压缩已取消' })
        : t('claudeStatus.compaction.tooShort', { defaultValue: '上下文还很短,暂时不用压缩' });
    }
    if (tone === 'stalled') {
      return t('claudeStatus.compaction.stalled', { defaultValue: '正在压缩上下文 —— CLI 已经一段时间没有响应' });
    }
    if (tone === 'slow') {
      return t('claudeStatus.compaction.slow', { defaultValue: '正在压缩上下文 —— 比平常久' });
    }
    return compaction.blocking
      ? t('claudeStatus.compaction.blocking', { defaultValue: '上下文已满,正在压缩后继续这一轮' })
      : t('claudeStatus.compacting', { defaultValue: '正在压缩上下文' });
  })();

  const fallbackWord = actionWords[Math.floor(elapsedSeconds / 4) % actionWords.length];
  const label = isCompacting
    ? compactionLabel
    // 结果过期后 statusText 还停在服务端那句英文 "Compacting context…" 上,
    // 不能拿它当兜底 —— 退回普通的动作词。
    : (resultExpired ? fallbackWord : (renderedActivity.statusText || fallbackWord)).replace(/\.+$/, '');

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  const elapsedLabel = minutes < 1
    ? t('claudeStatus.elapsed.seconds', { count: seconds, defaultValue: '{{count}}s' })
    : t('claudeStatus.elapsed.minutesSeconds', { minutes, seconds, defaultValue: '{{minutes}}m {{seconds}}s' });

  /**
   * 压缩右侧那一行。跑着的时候是「已用 42s · 上次 38s」——「上次」是这里唯一
   * 诚实的"还要多久"参照(压缩耗时基本随上下文大小走,同一段对话之间可比)。
   * 结束时换成实际耗时。
   */
  const compactionMeta = (() => {
    if (!compaction) return elapsedLabel;
    if (compaction.phase !== 'running') {
      return compaction.durationMs ? formatDuration(compaction.durationMs) : '';
    }
    const running = formatDuration(compactionElapsedMs);
    return compaction.lastDurationMs
      ? t('claudeStatus.compaction.elapsedWithLast', {
          elapsed: running,
          last: formatDuration(compaction.lastDurationMs),
          defaultValue: '{{elapsed}} · 上次 {{last}}',
        })
      : running;
  })();

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
        tone === 'done' ? (
          <Check className="relative h-[18px] w-[18px] flex-none text-primary" strokeWidth={2.5} aria-hidden />
        ) : tone === 'skipped' ? (
          // 空操作用归档图标的中性形态,不用警告 —— 什么都没出错。
          <Archive className="relative h-[18px] w-[18px] flex-none text-muted-foreground" strokeWidth={2} aria-hidden />
        ) : tone === 'failed' || tone === 'stalled' ? (
          <AlertTriangle className="relative h-[18px] w-[18px] flex-none text-muted-foreground" strokeWidth={2} aria-hidden />
        ) : (
          <Archive className="relative h-[18px] w-[18px] flex-none text-primary" strokeWidth={2} aria-hidden />
        )
      ) : (
        <svg className="relative h-[18px] w-[18px] flex-none" viewBox="0 0 18 18" aria-hidden>
          {RING_DOTS.map((dot, index) => (
            <circle key={index} cx={dot.cx} cy={dot.cy} r="1.4" className="fill-primary" opacity={dot.opacity} />
          ))}
        </svg>
      )}

      {tone === 'done' || tone === 'failed' || tone === 'skipped' ? (
        <span className="relative text-[13px] leading-5 text-foreground">{label}</span>
      ) : (
        <Shimmer className="relative text-[13px] leading-5">{`${label}…`}</Shimmer>
      )}

      {/* 心跳:只在 CLI 真的往流里推东西时跳一下。定时动画在真卡住时照转不误,
          这一颗不会 —— 它停了就是停了,和右边的"没有响应"是同一个事实。 */}
      {isCompacting && tone === 'running' && (
        <span
          key={compactionBeat ?? 0}
          className="prism-compaction-beat relative h-1.5 w-1.5 flex-none rounded-full bg-primary"
          aria-hidden
        />
      )}

      <span className="relative font-mono text-[11px] tabular-nums text-muted-foreground">
        {isCompacting ? compactionMeta : elapsedLabel}
      </span>
    </div>
  );
}
