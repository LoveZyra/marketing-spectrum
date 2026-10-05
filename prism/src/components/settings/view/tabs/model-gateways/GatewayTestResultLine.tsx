import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle } from 'lucide-react';

import type { GatewayTestResult } from './gatewaysApi';

/**
 * hq:「测试连接」的结果一行。测的是 `GET /v1/models`:通了只说明"地址通、key 被接受",
 * 某个模型能不能干活看那个模型的「实测」。失败原因是服务端的中文,原样显示。
 */
export default function GatewayTestResultLine({ result }: { result: GatewayTestResult }) {
  const { t } = useTranslation('settings');
  const sample = result.sampleModels.slice(0, 6);
  return (
    <div
      className={`flex min-w-0 items-start gap-1 text-[11px] leading-4 ${result.ok ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400'}`}
      role="status"
    >
      {result.ok ? <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-primary" /> : <XCircle className="mt-px h-3 w-3 shrink-0" />}
      <span className="min-w-0 break-words">
        {result.ok
          ? result.modelCount !== null
            ? t('gateways.test.okWithModels', { defaultValue: '连通 · {{ms}} ms · 网关列出 {{n}} 个模型', ms: result.latencyMs, n: result.modelCount })
            : t('gateways.test.ok', { defaultValue: '连通 · {{ms}} ms', ms: result.latencyMs })
          : t('gateways.test.failed', { defaultValue: '没通:{{error}}', error: result.error ?? (result.status !== null ? `HTTP ${result.status}` : '?') })}
        {result.ok && sample.length > 0 && (
          <span className="ml-1 break-all font-mono text-[10px]" title={result.sampleModels.join('\n')}>
            ({sample.join(', ')}{result.sampleModels.length > sample.length ? ', …' : ''})
          </span>
        )}
      </span>
    </div>
  );
}
