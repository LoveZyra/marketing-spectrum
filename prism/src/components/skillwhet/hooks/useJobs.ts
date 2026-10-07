import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import { unwrap, type Job, type ProgressEvent } from '../lib/types';

/**
 * 作业列表:有作业在排队 / 训练中时每 3 秒轮询一次,否则不轮询。
 * 页面切走(卸载)就停;`refresh()` 供动作完成后立刻拉。
 */
export const LIVE_STATES = new Set(['queued', 'running']);

export function useJobs(skill?: string | null, limit?: number) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const skillRef = useRef(skill ?? null);
  skillRef.current = skill ?? null;
  // 请求代号:每发一次 +1。响应回来时,发请求那会儿的技能已不是当前技能,或者比已经落到
  // 列表上的那次还旧,就丢弃:换了技能时上一个技能的作业不能串到新技能下;轮询与手动刷新
  // 交错时旧响应也不能把列表退回去(退成没有活作业时轮询还会就此停下)。
  // 不按「最新发出的那次」判:请求比 3 秒轮询间隔还慢时,那样每次响应都会被下一次作废。
  const genRef = useRef(0);
  const appliedGenRef = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++genRef.current;
    const skillAtCall = skillRef.current;
    const isStale = () => skillAtCall !== skillRef.current || gen < appliedGenRef.current;
    try {
      const data = await unwrap<{ jobs: Job[] }>(await api.skillWhet.jobs(skillAtCall, limit));
      if (isStale()) return;
      appliedGenRef.current = gen;
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setError(null);
    } catch (caught) {
      if (isStale()) return;
      appliedGenRef.current = gen;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    // 换了技能(或条数上限):先清掉旧列表,别让上一个技能的作业挂在新技能下等新响应。
    setJobs((prev) => (prev.length === 0 ? prev : []));
    setLoading(true);
    void refresh();
  }, [refresh, skill]);

  const live = jobs.some((job) => LIVE_STATES.has(job.state));
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [live, refresh]);

  return { jobs, loading, error, refresh, live };
}

/**
 * 一个作业的进度事件:按 `after=<seq>` 增量拉,跑着时每 3 秒;终态后拉最后一次就停。
 */
export function useJobProgress(jobId: string | null) {
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const genRef = useRef(0);          // 切换作业后,上一个作业迟到的响应作废
  const lastStateRef = useRef<string | null>(null);

  const pull = useCallback(async (id: string) => {
    const gen = genRef.current;
    try {
      const [detail, first] = await Promise.all([
        unwrap<{ job: Job }>(await api.skillWhet.job(id)),
        unwrap<{ events: ProgressEvent[]; state: string; last_seq: number }>(await api.skillWhet.jobProgress(id, seqRef.current)),
      ]);
      if (gen !== genRef.current) return null;
      setJob(detail.job);
      lastStateRef.current = detail.job.state;
      // 进度事件很细(每条任务、每个候选各一条),服务端一次最多回 500 条:满页就接着拉。
      let batch = first.events;
      for (let page = 0; batch.length > 0 && page < 60; page += 1) {
        const got = batch;
        setEvents((prev) => {
          // 手动刷新与定时器可能同时带着同一个 after 出去:按 seq 去重,只接更新的
          const have = prev.length > 0 ? prev[prev.length - 1].seq : 0;
          const fresh = got.filter((e) => e.seq > have);
          if (fresh.length === 0) return prev;
          return [...prev, ...fresh];
        });
        seqRef.current = Math.max(seqRef.current, got[got.length - 1].seq);
        if (got.length < 500) break;
        batch = (await unwrap<{ events: ProgressEvent[] }>(await api.skillWhet.jobProgress(id, seqRef.current))).events;
        if (gen !== genRef.current) return null;
      }
      setError(null);
      return detail.job;
    } catch (caught) {
      if (gen !== genRef.current) return null;
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  }, []);

  useEffect(() => {
    genRef.current += 1;
    seqRef.current = 0;
    lastStateRef.current = null;
    setEvents([]);
    setJob(null);
    if (!jobId) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    let failures = 0;
    const tick = async () => {
      const next = await pull(jobId);
      if (cancelled) return;
      if (next) failures = 0; else failures += 1;
      // 拉失败(网络抖一下)不停:只要上次看到的状态还是活的,退避后再试
      const live = next ? LIVE_STATES.has(next.state) : (lastStateRef.current === null || LIVE_STATES.has(lastStateRef.current));
      if (live && failures < 20) timer = window.setTimeout(() => void tick(), Math.min(3_000 * (failures + 1), 30_000));
    };
    void tick();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, [jobId, pull]);

  return { job, events, error, refresh: () => (jobId ? pull(jobId) : Promise.resolve(null)) };
}
