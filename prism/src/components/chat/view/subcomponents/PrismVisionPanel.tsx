import PrismLogo from '../../../PrismLogo';

/**
 * Prism welcome-screen vision panel (left column of the two-column empty
 * state). Surfaces the brand + product vision so the landing view reads as an
 * algorithm-analysis workbench, and fills the horizontal space on wide screens.
 */
export default function PrismVisionPanel() {
  const pillars = [
    { title: '一个入口', desc: '算法研发 · 数据分析 · 多 Agent 协作' },
    { title: '可信执行', desc: '每轮改动可视化 · 可审计 · 可回滚' },
    { title: '沉淀复用', desc: '团队的算法资产与方法持续积累' },
  ];

  return (
    <div className="prism-aurora relative flex h-full min-h-0 flex-col justify-center overflow-hidden rounded-2xl border border-border/60 p-6">
      <div className="flex items-center gap-2.5">
        <PrismLogo size={30} />
        <span
          className="prism-gradient-text text-lg font-semibold tracking-tight"
        >
          Prism
        </span>
      </div>

      <p className="prism-gradient-text mt-4 text-[1.3rem] font-medium leading-snug">
        把复杂的算法与数据问题，<br className="hidden sm:block" />分解为清晰、可执行、可回溯的智能工作流
      </p>

      <div className="mt-5 space-y-2.5">
        {pillars.map((pillar) => (
          <div key={pillar.title} className="flex gap-2.5">
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden />
            <div>
              <span className="text-sm font-medium text-foreground">{pillar.title}</span>
              <span className="ml-1.5 text-xs text-muted-foreground">{pillar.desc}</span>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-5 text-xs italic text-muted-foreground/60">
        Split complexity into insight.
      </p>
    </div>
  );
}
