import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../utils/api';

type SearchMatch = { path: string; line: number; column: number; text: string };

type Props = {
  projectId: string;
  onOpenMatch: (relativePath: string, line: number) => void;
  onClose: () => void;
};

/**
 * 跨文件全局搜索面板(F10)。
 *
 * 文件树自带的搜索框只匹配**文件名**;人真正要找的常常是内容 —— "那个函数叫什么
 * 来着"、"这个常量还有谁在用"。此前唯一的办法是打开终端自己 grep。
 *
 * 三个刻意的选择:
 *   - 默认**字面量**而不是正则。多数人搜的是字面量,而正则里的 `.` `(` `*` 会让
 *     结果莫名其妙;要正则的人知道去勾那个开关。
 *   - 结果按文件分组。一屏 300 条平铺没法读,而"哪个文件里有"通常就是答案。
 *   - 截断如实说。少给结果而不告诉人,比给少了更糟 —— 他会以为项目里就这么多。
 */
export default function ProjectSearchPanel({ projectId, onOpenMatch, onClose }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [glob, setGlob] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError(t('fileTree.search.tooShort', '搜索内容至少 2 个字符'));
      setMatches([]);
      return;
    }

    // 后发的请求赢:输入快时旧结果可能后到,不挡住的话列表会来回跳。
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setSearching(true);
    setError(null);

    try {
      const params = new URLSearchParams({ q: trimmed });
      if (caseSensitive) params.set('caseSensitive', 'true');
      if (regex) params.set('regex', 'true');
      if (glob.trim()) params.set('glob', glob.trim());

      const response = await authenticatedFetch(`/api/projects/${projectId}/search?${params.toString()}`);
      const payload = (await response.json()) as { matches?: SearchMatch[]; truncated?: boolean; error?: string };
      if (requestSeqRef.current !== seq) return;

      if (!response.ok) {
        setError(payload.error || `HTTP ${response.status}`);
        setMatches([]);
      } else {
        setMatches(payload.matches ?? []);
        setTruncated(Boolean(payload.truncated));
        setError(payload.error ?? null);
      }
      setHasSearched(true);
    } catch (caught) {
      if (requestSeqRef.current !== seq) return;
      setError(caught instanceof Error ? caught.message : String(caught));
      setMatches([]);
    } finally {
      if (requestSeqRef.current === seq) setSearching(false);
    }
  }, [query, caseSensitive, regex, glob, projectId, t]);

  const grouped = matches.reduce<Map<string, SearchMatch[]>>((acc, match) => {
    const bucket = acc.get(match.path);
    if (bucket) bucket.push(match);
    else acc.set(match.path, [match]);
    return acc;
  }, new Map());

  return (
    <div className="flex h-full flex-col border-b border-border bg-background">
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch();
            if (event.key === 'Escape') onClose();
          }}
          placeholder={t('fileTree.search.placeholder', '在项目内搜索内容…')}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={onClose}
          title={t('fileTree.search.close', '关闭搜索')}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} className="h-3 w-3" />
          {t('fileTree.search.caseSensitive', '区分大小写')}
        </label>
        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} className="h-3 w-3" />
          {t('fileTree.search.regex', '正则')}
        </label>
        <input
          value={glob}
          onChange={(event) => setGlob(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }}
          placeholder={t('fileTree.search.glob', '文件过滤,如 *.ts')}
          className="w-32 rounded border border-border bg-transparent px-1.5 py-0.5 font-mono outline-none"
        />
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={searching}
          className="ml-auto rounded border border-border px-2 py-0.5 transition-colors hover:bg-accent disabled:opacity-50"
        >
          {searching ? t('fileTree.search.searching', '搜索中…') : t('fileTree.search.run', '搜索')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {error && <p className="px-1 py-2 text-xs text-muted-foreground">{error}</p>}

        {!error && hasSearched && matches.length === 0 && !searching && (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t('fileTree.search.noMatches', '没有找到匹配内容')}</p>
        )}

        {matches.length > 0 && (
          <p className="px-1 py-1 text-[11px] text-muted-foreground">
            {t('fileTree.search.summary', {
              matches: matches.length,
              files: grouped.size,
              defaultValue: `${matches.length} 处命中 · ${grouped.size} 个文件`,
            })}
            {truncated && ` · ${t('fileTree.search.truncated', '已达上限,结果被截断')}`}
          </p>
        )}

        {[...grouped.entries()].map(([filePath, fileMatches]) => (
          <div key={filePath} className="mb-1.5">
            <div className="truncate px-1 py-0.5 font-mono text-[11px] text-foreground" title={filePath}>
              {filePath}
              <span className="ml-1.5 text-muted-foreground">{fileMatches.length}</span>
            </div>
            {fileMatches.map((match) => (
              <button
                key={`${match.line}:${match.column}`}
                type="button"
                onClick={() => onOpenMatch(match.path, match.line)}
                className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
              >
                <span className="w-9 flex-shrink-0 text-right font-mono text-[11px] text-muted-foreground">{match.line}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-body">{match.text.trim()}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
