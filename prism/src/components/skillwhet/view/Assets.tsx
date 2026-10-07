import { useMemo, useState } from 'react';
import { Download, Loader2, MessageSquareText, Search, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../../../utils/api';
import { useToast } from '../../../shared/view/ui';
import type { SkillWhetStatus } from '../hooks/useSkillWhetStatus';
import { unwrap } from '../lib/types';
import type { SkillWhetData } from '../SkillWhetPage';

import SkillCard from './SkillCard';
import StatusStrip, { Badge } from './StatusStrip';
import UploadSkillDialog from './UploadSkillDialog';

/**
 * 技能资产:受管副本一卡一张;技能库里有但没导入的、只在对话反馈里出现过的,
 * 也各列一排(让 root 一眼看到能导什么、哪些技能用户在用却还没进训练)。
 */
type AssetsProps = {
  status: SkillWhetStatus | null;
  data: SkillWhetData;
  isRoot: boolean;
  username: string;
  onRecheck: () => void;
  onTrain: (skill: string) => void;
};

export default function Assets({ status, data, isRoot, username, onRecheck, onTrain }: AssetsProps) {
  const { t } = useTranslation('skillwhet');
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const match = (name: string) => !needle || name.toLowerCase().includes(needle);
  const managed = useMemo(
    () => (data.skills?.skills ?? []).filter((skill) => !needle || skill.name.toLowerCase().includes(needle)),
    [data.skills, needle],
  );
  const liveOnly = (data.skills?.liveOnly ?? []).filter(match);
  const feedbackOnly = (data.skills?.feedbackOnly ?? []).filter(match);

  const importOne = async (name: string) => {
    setImporting(name);
    try {
      await unwrap(await api.skillWhet.importSkill(name, false));
      toast({ message: t('assets.importDone', { defaultValue: '已导入 {{name}} 的副本', name }), variant: 'success' });
      await data.refresh();
    } catch (error) {
      toast({ message: error instanceof Error ? error.message : String(error), variant: 'error' });
    } finally {
      setImporting(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        {/* 窄屏时标题块独占一行,sm 起再与搜索框 / 按钮并排,免得手机上被挤成一字一列。 */}
        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
          <h1 className="text-xl font-semibold text-foreground">{t('assets.title', { defaultValue: '技能资产' })}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('assets.subtitle', { defaultValue: '受管副本来自技能库导入或你自己上传;训练只在副本上跑,live 只在「发布」时被替换。' })}</p>
        </div>
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-[13px] text-muted-foreground sm:w-[220px] sm:flex-none">
          <Search className="h-3.5 w-3.5" aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('assets.search', { defaultValue: '搜索技能' })} aria-label={t('assets.search', { defaultValue: '搜索技能' })} className="min-w-0 flex-1 bg-transparent text-foreground outline-none" />
        </label>
        <button type="button" onClick={() => setUploadOpen(true)} className="prism-action inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px]">
          <Upload className="h-3.5 w-3.5" aria-hidden />{t('assets.upload', { defaultValue: '上传技能' })}
        </button>
      </div>

      <StatusStrip status={status} onRecheck={onRecheck} />

      {data.error && <div className="rounded-panel border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{data.error}</div>}

      {data.loading && !data.skills && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('assets.loading', { defaultValue: '正在读取受管副本…' })}</div>
      )}

      {data.skills && managed.length === 0 && liveOnly.length === 0 && feedbackOnly.length === 0 && (
        <div className="rounded-panel border border-dashed border-border px-6 py-12 text-center text-[13px] text-muted-foreground">
          {needle
            ? t('assets.noMatch', { defaultValue: '没有匹配「{{q}}」的技能', q: query })
            : t('assets.empty', { defaultValue: '还没有任何受管副本。root 可从技能库导入;任何人都可以上传自己的 skill。' })}
        </div>
      )}

      {managed.length > 0 && (
        <div className="grid grid-cols-2 gap-3.5 max-lg:grid-cols-1">
          {managed.map((skill) => (
            <SkillCard key={skill.name} skill={skill} isRoot={isRoot} username={username} onChanged={data.refresh} onTrain={onTrain}
              nightly={data.nightly} />
          ))}
        </div>
      )}

      {liveOnly.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('assets.liveOnly', { defaultValue: '技能库里有、还没导入副本' })}
            <span className="font-mono normal-case text-muted-foreground">{data.skills?.liveRoot}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {liveOnly.map((name) => (
              <div key={name} className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-[13px]">
                <span className="font-mono text-foreground">{name}</span>
                <Badge>{t('assets.notImported', { defaultValue: '未导入' })}</Badge>
                {isRoot ? (
                  <button type="button" onClick={() => void importOne(name)} disabled={importing !== null} className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-xs text-foreground hover:border-border-strong disabled:opacity-50">
                    {importing === name ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Download className="h-3 w-3" aria-hidden />}
                    {t('assets.import', { defaultValue: '导入副本' })}
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground">{t('assets.rootOnly', { defaultValue: 'root 才能导入' })}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {feedbackOnly.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('assets.feedbackOnly', { defaultValue: '对话里有反馈、但技能库与副本里都没有' })}</div>
          <div className="flex flex-wrap gap-2">
            {feedbackOnly.map((name) => (
              <div key={name} className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-[13px]">
                <MessageSquareText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <span className="font-mono text-foreground">{name}</span>
                <span className="text-xs text-muted-foreground">{t('assets.feedbackOnlyHint', { defaultValue: '可能是项目级技能或名字写错;导入后反馈才会挂上' })}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {uploadOpen && <UploadSkillDialog onClose={() => setUploadOpen(false)} onUploaded={data.refresh} />}
    </div>
  );
}
