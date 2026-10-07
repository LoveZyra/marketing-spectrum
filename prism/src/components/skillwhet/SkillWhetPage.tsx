import { useCallback, useEffect, useState } from 'react';
import {
  Activity, BookOpen, Database, FlaskConical, History, LayoutGrid, Layers, ShieldCheck,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/context/AuthContext';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import { api } from '../../utils/api';

import { useSkillWhetStatus } from './hooks/useSkillWhetStatus';
import { unwrap, type NightlyResponse, type SkillsResponse, type TaskSummary } from './lib/types';
import Assets from './view/Assets';
import Evaluation from './view/Evaluation';
import Overview from './view/Overview';
import RunDetail from './view/RunDetail';
import Runs from './view/Runs';
import Tasks from './view/Tasks';
import Versions from './view/Versions';
import Wiki from './view/Wiki';

/**
 * 「技能优化」页:SkillWhet 在 Prism 里的入口。
 *
 * 左侧七项子导航:总览、技能资产、任务集、优化训练(作业表 + 新建 + 详情)、评测、经验 Wiki(只读)、
 * 版本(staging → 采纳 → 发布 / 回滚)。技能列表、任务集汇总与夜训计划在这一层拉一次、各子页共用;
 * 子页做了动作(导入 / bootstrap / 入库 / 采纳 / 发布…)后调 `refresh()` 重拉。
 *
 * 跨页跳转的状态放在这一层:技能卡「新建训练」→ runs(预选 skill);总览 / 作业表点作业 →
 * 运行详情(`openJob`);详情 / 评测「审阅」→ versions(预选 skill + staging)。
 *
 * 权限只在这里读一次(`user.isRoot`)传下去;真正的门在服务端
 * (`assertMayMutate`:技能库来源 → root,上传来源 → 上传者本人或 root)。
 */
export type SkillWhetSection = 'overview' | 'runs' | 'assets' | 'tasks' | 'wiki' | 'eval' | 'versions';

export type SkillWhetData = {
  skills: SkillsResponse | null;
  taskSummary: TaskSummary[];
  /** 夜训计划;serve 不支持夜训或路由不存在时为 null,各页不画夜训那一块。 */
  nightly: NightlyResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export default function SkillWhetPage() {
  const { t } = useTranslation('skillwhet');
  const { user } = useAuth();
  const isRoot = Boolean(user?.isRoot);
  const username = user?.username ?? '';
  const userId = typeof user?.id === 'number' ? user.id : null;
  const { status, reload: reloadStatus } = useSkillWhetStatus();
  const [section, setSection] = useState<SkillWhetSection>('assets');
  const [skills, setSkills] = useState<SkillsResponse | null>(null);
  const [taskSummary, setTaskSummary] = useState<TaskSummary[]>([]);
  const [nightly, setNightly] = useState<NightlyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [runSkill, setRunSkill] = useState<string | null>(null);
  const [versionTarget, setVersionTarget] = useState<{ skill: string | null; staging: string | null }>({ skill: null, staging: null });

  const goRuns = (skill: string | null) => { setRunSkill(skill); setOpenJob(null); setSection('runs'); };
  // 点左栏「优化训练」总是回到作业列表:清掉 openJob,否则会停在上次打开的运行详情。
  const goSection = (id: SkillWhetSection) => { if (id === 'runs') setOpenJob(null); setSection(id); };
  const goVersions = (skill: string, staging: string | null) => { setVersionTarget({ skill, staging }); setSection('versions'); };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [skillsData, tasksData, nightlyData] = await Promise.all([
        unwrap<SkillsResponse>(await api.skillWhet.skills()),
        unwrap<{ summary: TaskSummary[] }>(await api.skillWhet.tasks()).catch(() => ({ summary: [] as TaskSummary[] })),
        (async () => unwrap<NightlyResponse>(await api.skillWhet.nightly()))().catch(() => null),
      ]);
      setSkills(skillsData);
      setNightly(nightlyData);
      setTaskSummary(Array.isArray(tasksData.summary) ? tasksData.summary : []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const data: SkillWhetData = { skills, taskSummary, nightly, loading, error, refresh };

  const nav: Array<{ id: SkillWhetSection; icon: typeof LayoutGrid; label: string; count?: number }> = [
    // 按一次训练的先后顺序排列。
    { id: 'overview', icon: LayoutGrid, label: t('nav.overview', { defaultValue: '总览' }) },
    { id: 'assets', icon: Layers, label: t('nav.assets', { defaultValue: '技能资产' }), count: skills?.skills.length },
    { id: 'tasks', icon: Database, label: t('nav.tasks', { defaultValue: '任务集' }), count: taskSummary.reduce((sum, row) => sum + row.total, 0) || undefined },
    { id: 'runs', icon: Activity, label: t('nav.runs', { defaultValue: '优化训练' }) },
    { id: 'eval', icon: FlaskConical, label: t('nav.eval', { defaultValue: '评测' }) },
    { id: 'wiki', icon: BookOpen, label: t('nav.wiki', { defaultValue: '经验 Wiki' }) },
    { id: 'versions', icon: History, label: t('nav.versions', { defaultValue: '版本' }) },
  ];

  const crumb = nav.find((item) => item.id === section)?.label ?? '';
  // 左轨的开合按钮在这一页控制这条子导航;收起时改用顶部横向页签,导航入口不丢。
  const { preferences } = useUiPreferences();
  const navOpen = preferences.skillNavVisible !== false;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="skillwhet-page">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-[13px]">
        <span className="text-muted-foreground">{t('title', { defaultValue: '技能优化' })}</span>
        <span className="text-muted-foreground">›</span>
        <strong className="font-semibold text-foreground">{crumb}</strong>
        <div className="flex-1" />
        {status?.target && (
          <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{status.target}</span>
        )}
      </header>
      <div className={`flex min-h-0 flex-1 ${navOpen ? 'max-md:flex-col' : 'flex-col'}`}>
        <aside className={`w-[208px] shrink-0 flex-col gap-0.5 border-r border-border px-2.5 py-4 ${navOpen ? 'flex max-md:hidden' : 'hidden'}`} data-testid="skill-nav">
          <div className="px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Skill Studio</div>
          {nav.map(({ id, icon: Icon, label, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => goSection(id)}
              aria-current={section === id ? 'page' : undefined}
              className={`flex h-8 items-center gap-2.5 rounded-md px-3 text-[13px] transition-colors ${section === id ? 'bg-accent font-medium text-accent-foreground' : 'text-body hover:bg-muted hover:text-foreground'}`}
            >
              <Icon className="h-[15px] w-[15px]" aria-hidden />
              <span className="flex-1 text-left">{label}</span>
              {count !== undefined && count > 0 && <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">{count}</span>}
            </button>
          ))}
          <div className="flex-1" />
          <div className="rounded-panel border border-border bg-card px-3 py-2.5 text-xs leading-[18px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />{t('sidebar.motto', { defaultValue: '模型固定,技能进化' })}</span>
            <br />
            <span className="text-body">{t('sidebar.mottoSub', { defaultValue: '训练只写副本,发布要 root 点' })}</span>
          </div>
        </aside>
        <div className={`flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5 ${navOpen ? 'md:hidden' : ''}`} data-testid="skill-tabs">
          {nav.map(({ id, label }) => (
            <button key={id} type="button" onClick={() => goSection(id)}
              className={`h-7 whitespace-nowrap rounded-md px-2.5 text-xs ${section === id ? 'bg-accent text-accent-foreground' : 'text-body'}`}>
              {label}
            </button>
          ))}
        </div>
        <main className="min-w-0 flex-1 overflow-y-auto px-7 py-6 max-md:px-4">
          {section === 'overview' && <Overview status={status} data={data} onRecheck={() => void reloadStatus()} onOpenJob={(id) => { setOpenJob(id); setSection('runs'); }} onOpenRuns={() => goRuns(null)} />}
          {section === 'assets' && <Assets status={status} data={data} isRoot={isRoot} username={username} onRecheck={() => void reloadStatus()} onTrain={(skill) => goRuns(skill)} />}
          {section === 'tasks' && <Tasks data={data} isRoot={isRoot} username={username} />}
          {section === 'wiki' && <Wiki data={data} />}
          {section === 'runs' && (openJob
            ? <RunDetail key={openJob} jobId={openJob} isRoot={isRoot} userId={userId} onBack={() => setOpenJob(null)} onOpenVersions={goVersions} onOpenJob={(id) => setOpenJob(id)} />
            : <Runs data={data} isRoot={isRoot} username={username} userId={userId} initialSkill={runSkill} onOpen={(id) => setOpenJob(id)} />)}
          {section === 'eval' && <Evaluation data={data} onOpenVersions={goVersions} />}
          {section === 'versions' && <Versions data={data} isRoot={isRoot} username={username} initialSkill={versionTarget.skill} initialStaging={versionTarget.staging} />}
        </main>
      </div>
    </div>
  );
}
