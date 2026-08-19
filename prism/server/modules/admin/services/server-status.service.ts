/**
 * 服务器状态采集(root 面板):负载/内存/磁盘/运行时长/版本 + Jupyter + 网关连通。
 *
 * 网关探测只打 BASE_URL 的源站拿连通性和延迟,**从不携带鉴权 token**;
 * 401/404 都算"可达"——我们量的是网络这一跳,不是账号有效性。
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { getJupyterStatus, type JupyterStatus } from '@/modules/jupyter/index.js';
import { WORKSPACES_ROOT } from '@/shared/utils.js';

export type DiskStatus = {
  path: string;
  totalKb: number;
  usedKb: number;
  availableKb: number;
  usedPercent: number;
} | null;

export type GatewayStatus = {
  host: string;
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
} | null;

export type ServerStatus = {
  now: string;
  appVersion: string | null;
  nodeVersion: string;
  processUptimeSec: number;
  osUptimeSec: number;
  load1: number;
  cpuCount: number;
  memory: { totalBytes: number; freeBytes: number; processRssBytes: number };
  disk: DiskStatus;
  jupyter: JupyterStatus;
  gateway: GatewayStatus;
};

/** 解析 `df -kP <path>` 输出。纯函数,单测钉格式。 */
export function parseDfOutput(text: string, forPath: string): DiskStatus {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  // POSIX 格式:Filesystem 1024-blocks Used Available Capacity Mounted on
  const parts = lines[lines.length - 1].trim().split(/\s+/);
  if (parts.length < 6) return null;
  const totalKb = Number.parseInt(parts[1], 10);
  const usedKb = Number.parseInt(parts[2], 10);
  const availableKb = Number.parseInt(parts[3], 10);
  const usedPercent = Number.parseInt(parts[4].replace('%', ''), 10);
  if (![totalKb, usedKb, availableKb, usedPercent].every(Number.isFinite)) return null;
  return { path: forPath, totalKb, usedKb, availableKb, usedPercent };
}

function readDisk(): Promise<DiskStatus> {
  return new Promise((resolve) => {
    execFile('df', ['-kP', WORKSPACES_ROOT], { timeout: 4_000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(parseDfOutput(String(stdout), WORKSPACES_ROOT));
    });
  });
}

/** settings.json env 优先,进程 env 兜底 —— 与 CLI 实际生效来源一致。 */
async function readGatewayBaseUrl(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const fromSettings = typeof parsed.env?.ANTHROPIC_BASE_URL === 'string' ? parsed.env.ANTHROPIC_BASE_URL.trim() : '';
    if (fromSettings) return fromSettings;
  } catch {
    // 没有 settings.json 就看进程环境
  }
  const fromProcess = process.env.ANTHROPIC_BASE_URL?.trim();
  return fromProcess || null;
}

function probeGateway(baseUrl: string): Promise<GatewayStatus> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return resolve({ host: baseUrl, reachable: false, statusCode: null, latencyMs: null, error: 'URL 无法解析' });
    }
    const client = url.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const request = client.get(
      { host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: '/', timeout: 4_000 },
      (response) => {
        response.resume();
        resolve({
          host: url.host,
          reachable: true,
          statusCode: response.statusCode ?? null,
          latencyMs: Date.now() - startedAt,
          error: null,
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => {
      resolve({
        host: url.host,
        reachable: false,
        statusCode: null,
        latencyMs: null,
        error: (error as NodeJS.ErrnoException).code ?? error.message,
      });
    });
  });
}

export async function collectServerStatus(options: { appVersion: string | null }): Promise<ServerStatus> {
  const baseUrl = await readGatewayBaseUrl();
  const [disk, gateway] = await Promise.all([
    readDisk(),
    baseUrl ? probeGateway(baseUrl) : Promise.resolve<GatewayStatus>(null),
  ]);

  return {
    now: new Date().toISOString(),
    appVersion: options.appVersion,
    nodeVersion: process.version,
    processUptimeSec: Math.round(process.uptime()),
    osUptimeSec: Math.round(os.uptime()),
    load1: os.loadavg()[0],
    cpuCount: os.cpus().length,
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
      processRssBytes: process.memoryUsage().rss,
    },
    disk,
    jupyter: getJupyterStatus(),
    gateway,
  };
}
