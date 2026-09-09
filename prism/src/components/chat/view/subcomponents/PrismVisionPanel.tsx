import PrismLogo from '../../../PrismLogo';
import PrismWordmark from '../../../PrismWordmark';

/**
 * 首页空态左栏的品牌区 —— 品牌标识 + 产品主张,让落地页一眼读得出这是一个
 * 算法分析工作台,同时在宽屏上把左半边填住。
 *
 * ## 它被撤过一轮,又被要回来了
 *
 * ef 把首页改成了「问候语 + 内嵌输入框 + 半高起手卡 + 最近会话」,理由是
 * "每开一个新会话都要再看一遍登录页讲过的口号"。ex 按用户要求整体还原回
 * ef 之前的两栏版式 —— 那套理由没有错,但**这是产品口味的选择,不是对错题**:
 * 谁天天开新会话谁嫌口号啰嗦,而把 Prism 打开给别人看的时候,这块正是要讲的东西。
 *
 * 所以这个文件是原样取回的(ee 版逐字),不要顺手"优化"它 —— 下次若再要换回
 * ef 那版,对着 CHANGELOG 的 ef / ex 两条互查即可。
 */
export default function PrismVisionPanel() {
  const pillars = [
    { title: '一个入口', desc: '算法研发 · 数据分析 · 多 Agent 协作' },
    { title: '可信执行', desc: '每轮改动可视化 · 可审计 · 可回滚' },
    { title: '沉淀复用', desc: '团队的算法资产与方法持续积累' },
  ];

  return (
    <div className="relative flex h-full min-h-0 flex-col justify-center overflow-hidden rounded-lg border border-border p-6">
      <div className="flex items-center gap-3.5">
        <PrismLogo size={56} />
        <span className="inline-flex items-center text-foreground">
          <PrismWordmark height={30} />
        </span>
      </div>

      <p className="mt-4 text-[1.3rem] font-medium leading-snug text-foreground">
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

      <p className="mt-5 text-xs italic text-muted-foreground">
        Split complexity into insight.
      </p>
    </div>
  );
}
