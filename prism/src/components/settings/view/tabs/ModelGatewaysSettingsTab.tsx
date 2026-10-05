import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, RefreshCw } from 'lucide-react';

import { useAuth } from '../../../auth/context/AuthContext';

import MyGatewayKeyCard from './model-gateways/MyGatewayKeyCard';
import MyPrivateGatewaysSection from './model-gateways/MyPrivateGatewaysSection';
import MyPrivateModelsSection from './model-gateways/MyPrivateModelsSection';
import { privateSectionMode, splitMyGateways, withPrivateModelCounts } from './model-gateways/gatewayLogic';
import { errorMessage, myGatewaysApi, type MyGatewaysPayload, type MyGatewayView } from './model-gateways/gatewaysApi';
import type { CatalogEntry } from './model-catalog/modelCatalogApi';

/**
 * hq:设置 →「模型网关」(每个人都有,root 也一样用它填自己的 key)。
 *
 * 1. **我的 key**:默认网关 + 启用的共享网关,各一张卡 —— 我的回合用哪把 key、上面有哪些我能用的模型;
 *    填 / 换 / 清我的个人 key(个人的优先于网关默认 key,只给我自己的回合用);
 * 2. **我的私有网关**:root 允许时可加;root 关掉后,已有的只能删;
 * 3. **我的私有模型**:挂在私有网关上,只有我看得到。
 */
export default function ModelGatewaysSettingsTab() {
  const { t } = useTranslation('settings');
  const me = useAuth().user?.username ?? null;
  const [data, setData] = useState<MyGatewaysPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await myGatewaysApi.list();
      if (seq === seqRef.current) setData(next);
    } catch (caught) {
      if (seq === seqRef.current) setError(errorMessage(caught));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setGateways = (gateways: MyGatewayView[]) => setData((current) => (current ? { ...current, gateways } : current));
  const setModels = (models: CatalogEntry[]) => setData((current) => (current ? { ...current, models } : current));

  const { keyed, owned: ownedRaw } = splitMyGateways(data?.gateways ?? []);
  const owned = withPrivateModelCounts(ownedRaw, data?.models ?? []);
  const mode = data ? privateSectionMode(data.allowPrivate, owned.length, data.models.length) : 'hidden';

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 basis-64">
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              {t('gateways.mine.title', { defaultValue: '我的 key' })}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {t('gateways.mine.rules', { defaultValue: 'key 只给你自己用(你发的消息、你的定时任务和 API 调用);个人 key 优先于网关默认 key。' })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-body transition-colors hover:border-border-strong hover:bg-card hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-primary' : ''}`} />
            {t('gateways.common.reload', { defaultValue: '重新读取' })}
          </button>
        </div>

        {error && <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="alert">{error}</p>}
        {!data && !error && (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">{t('gateways.common.loading', { defaultValue: '读取中…' })}</p>
        )}

        {data && (
          <div className="space-y-3">
            {keyed.map((gateway) => (
              <MyGatewayKeyCard key={gateway.id} gateway={gateway} me={me} onGateways={setGateways} />
            ))}
          </div>
        )}
      </section>

      {data && mode !== 'hidden' && (
        <div className="border-t border-border pt-5">
          <MyPrivateGatewaysSection owned={owned} mode={mode} onGateways={setGateways} onModels={setModels} />
        </div>
      )}

      {data && mode !== 'hidden' && (
        <div className="border-t border-border pt-5">
          <MyPrivateModelsSection models={data.models} owned={owned} mode={mode} onModels={setModels} />
        </div>
      )}
    </div>
  );
}
