import { version as currentVersion } from '../../../../../package.json';
import PrismLogo from '../../../PrismLogo';
import PrismWordmark from '../../../PrismWordmark';

/**
 * Prism About: brand, version and the product vision. No update badges,
 * external links or upsells.
 */
export default function AboutTab() {

  return (
    <div className="space-y-6">
      {/* Brand + version */}
      <div className="flex items-center gap-3">
        <PrismLogo size={44} />
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center text-foreground">
              <PrismWordmark height={18} />
            </span>
            <span className="rounded-sm border border-border px-1.5 py-px font-mono text-[11px] font-medium text-muted-foreground">
              v{currentVersion}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            公共算法与分析 Agent 工作台
          </p>
        </div>
      </div>

      {/* Vision */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium text-foreground">愿景</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          像棱镜把一束光分解为完整的光谱，棱镜把复杂的算法与数据问题，
          分解为清晰、可执行、可回溯的智能工作流。
        </p>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <span className="text-foreground dark:text-primary">·</span>
            <span><span className="text-foreground">一个入口</span> —— 统一承载算法研发、数据分析与多 Agent 协作</span>
          </li>
          <li className="flex gap-2">
            <span className="text-foreground dark:text-primary">·</span>
            <span><span className="text-foreground">可信执行</span> —— 每一轮改动可视化、可审计、可一键回滚</span>
          </li>
          <li className="flex gap-2">
            <span className="text-foreground dark:text-primary">·</span>
            <span><span className="text-foreground">沉淀复用</span> —— 团队的算法资产与分析方法在这里持续积累</span>
          </li>
        </ul>
        <p className="mt-3 text-xs italic text-muted-foreground">
          Split complexity into insight.
        </p>
      </div>
    </div>
  );
}
