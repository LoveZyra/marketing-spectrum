import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../utils/api';
import { unwrap, type Job, type ProgressEvent } from '../lib/types';

/**
 * gz:作业列表 —— 有作业在排队 / 训练中时每 3 秒轮询一次,否则不动。
 * 页面切走(卸载)就停;`refresh()` 供动作完成后立刻拉。
 */
export const LIVE_STATES = new Set(['queued', 'running']);

export function useJobs(skill?: string | null, limit?: number) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const skillRef = useRef(skill ?? null);
  skillRef.current = skill ?? null;

  const refresh = useCallback(async () => {
    try {
      const data = await unwrap<{ jobs: Job[] }>(await api.skillWhet.jobs(skillRef.current, limit));
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { void refresh(); }, [refresh, skill]);

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
      // hd:进度事件变细了(每条任务、每个候选一条),一次最多回 500 条 —— 满页就接着拉,不再只看到前 500 条
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
