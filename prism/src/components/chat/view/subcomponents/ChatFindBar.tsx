import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { findOccurrenceStarts, stepMatchIndex } from '../../utils/findMatches';

/**
 * 会话内查找条(Ctrl+F,F1)。
 *
 * 匹配走**渲染后的 DOM 文本**(TreeWalker 收集文本节点),所以 markdown 渲染
 * 出来什么就能搜到什么;整词高亮用 CSS Custom Highlight API(`CSS.highlights`)
 * —— 不往 React 管的 DOM 里塞 <mark>,流式更新不会打架。浏览器不支持该 API 时
 * (老内核)退化为只滚动定位 + 命中消息闪环,功能仍完整。
 *
 * Enter 下一个、Shift+Enter 上一个、Esc 关闭(ChatInterface 的全局 Esc 中止
 * 已对 `[data-find-bar-open]` 放行,不会误杀 run)。
 */

const FIND_HIGHLIGHT = 'prism-find';
const FIND_HIGHLIGHT_CURRENT = 'prism-find-current';

type DomMatch = {
  node: Text;
  start: number;
  end: number;
};

const highlightsApi = (): { set: (name: string, h: unknown) => void; delete: (name: string) => void } | null => {
  const css = (globalThis as { CSS?: { highlights?: unknown } }).CSS;
  const highlights = css?.highlights as { set?: unknown; delete?: unknown } | undefined;
  if (highlights && typeof highlights.set === 'function' && typeof highlights.delete === 'function') {
    return highlights as { set: (name: string, h: unknown) => void; delete: (name: string) => void };
  }
  return null;
};

/** 收集容器里所有可见文本节点中的命中。跳过查找条自身与 script/style。 */
function collectMatches(container: HTMLElement, query: string): DomMatch[] {
  if (!query.trim()) return [];
  const matches: DomMatch[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('[data-find-bar-open], script, style, textarea')) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const limit = 2000; // 防御性上限:超长会话 + 单字查询时别把主线程拖死
  while (matches.length < limit) {
    const node = walker.nextNode() as Text | null;
    if (!node) break;
    for (const start of findOccurrenceStarts(node.nodeValue || '', query)) {
      matches.push({ node, start, end: start + query.length });
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

function applyHighlights(matches: DomMatch[], currentIndex: number): void {
  const api = highlightsApi();
  if (!api) return;
  const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!HighlightCtor) return;
  const toRange = (match: DomMatch): Range | null => {
    try {
      const range = new Range();
      range.setStart(match.node, match.start);
      range.setEnd(match.node, match.end);
      return range;
    } catch {
      return null; // 节点在扫描后被 React 换掉了 —— 下次重扫会补上
    }
  };
  const all = matches.map(toRange).filter((r): r is Range => Boolean(r));
  api.set(FIND_HIGHLIGHT, new HighlightCtor(...all));
  const current = currentIndex >= 0 && currentIndex < matches.length ? toRange(matches[currentIndex]) : null;
  api.set(FIND_HIGHLIGHT_CURRENT, current ? new HighlightCtor(current) : new HighlightCtor());
}

function clearHighlights(): void {
  const api = highlightsApi();
  if (!api) return;
  api.delete(FIND_HIGHLIGHT);
  api.delete(FIND_HIGHLIGHT_CURRENT);
}

interface ChatFindBarProps {
  open: boolean;
  onClose: () => void;
  scrollContainerRef: RefObject<HTMLDivElement>;
  /** 消息流的变化信号(条数+尾部长度即可),开着查找条时据此重扫。 */
  contentVersion: number;
}

export default function ChatFindBar({ open, onClose, scrollContainerRef, contentVersion }: ChatFindBarProps) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<DomMatch[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scan = useCallback((nextQuery: string, keepIndex: boolean) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const matches = collectMatches(container, nextQuery);
    matchesRef.current = matches;
    setMatchCount(matches.length);
    setCurrentIndex((previous) => {
      const next = matches.length === 0 ? -1 : keepIndex && previous >= 0 && previous < matches.length ? previous : 0;
      applyHighlights(matches, next);
      return next;
    });
  }, [scrollContainerRef]);

  const scrollToMatch = useCallback((index: number) => {
    const match = matchesRef.current[index];
    const el = match?.node.parentElement;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    // 不支持 Highlight API 的内核:给命中消息一个闪环,至少能看见跳到哪了
    if (!highlightsApi()) {
      const message = el.closest('.chat-message');
      if (message) {
        message.classList.remove('search-highlight-flash');
        void (message as HTMLElement).offsetWidth;
        message.classList.add('search-highlight-flash');
      }
    }
  }, []);

  const step = useCallback((direction: 'next' | 'prev') => {
    const total = matchesRef.current.length;
    setCurrentIndex((previous) => {
      const next = stepMatchIndex(previous, total, direction);
      if (next >= 0) {
        applyHighlights(matchesRef.current, next);
        scrollToMatch(next);
      }
      return next;
    });
  }, [scrollToMatch]);

  // 打开即聚焦;关闭清空高亮与状态。
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
      if (query.trim()) scan(query, false);
      return;
    }
    clearHighlights();
    matchesRef.current = [];
    setMatchCount(0);
    setCurrentIndex(-1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 输入防抖重扫;消息流有变化(流式/翻页)时也重扫,保住命中与序号。
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      scan(query, true);
      debounceRef.current = null;
    }, 160);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [open, query, contentVersion, scan]);

  // 卸载兜底清理。
  useEffect(() => () => clearHighlights(), []);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? 'prev' : 'next');
    }
  }, [onClose, step]);

  const counterText = useMemo(() => {
    if (!query.trim()) return '';
    if (matchCount === 0) return t('findBar.noMatches', { defaultValue: '无结果' });
    return `${currentIndex + 1}/${matchCount}`;
  }, [query, matchCount, currentIndex, t]);

  if (!open) return null;

  return (
    <div
      data-find-bar-open="true"
      className="prism-panel absolute right-4 top-2 z-30 flex items-center gap-1 rounded-lg border border-border bg-popover px-2 py-1.5 shadow-md"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('findBar.placeholder', { defaultValue: '在对话中查找…' })}
        aria-label={t('findBar.placeholder', { defaultValue: '在对话中查找…' })}
        className="w-44 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span className="min-w-14 text-right font-mono text-[11px] text-muted-foreground">{counterText}</span>
      <button
        type="button"
        onClick={() => step('prev')}
        disabled={matchCount === 0}
        title={t('findBar.previous', { defaultValue: '上一个 (Shift+Enter)' })}
        aria-label={t('findBar.previous', { defaultValue: '上一个 (Shift+Enter)' })}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => step('next')}
        disabled={matchCount === 0}
        title={t('findBar.next', { defaultValue: '下一个 (Enter)' })}
        aria-label={t('findBar.next', { defaultValue: '下一个 (Enter)' })}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        title={t('findBar.close', { defaultValue: '关闭 (Esc)' })}
        aria-label={t('findBar.close', { defaultValue: '关闭 (Esc)' })}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
