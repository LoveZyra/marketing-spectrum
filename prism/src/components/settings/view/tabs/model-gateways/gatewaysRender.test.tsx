import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, test } from 'vitest';

import i18n, { initI18n, whenFallbackReady } from '../../../../../i18n/config.js';
import ModelCatalogEditor from '../model-catalog/ModelCatalogEditor';
import type { CatalogEntry } from '../model-catalog/modelCatalogApi';

import GatewayForm from './GatewayForm';
import KeyEntryForm from './KeyEntryForm';
import MyGatewayKeyCard from './MyGatewayKeyCard';
import MyPrivateGatewaysSection from './MyPrivateGatewaysSection';
import MyPrivateModelsSection from './MyPrivateModelsSection';
import SharedGatewayRow from './SharedGatewayRow';
import type { GatewayView, MyGatewayView } from './gatewaysApi';

/**
 * 网关设置页的几块在 node 里渲染一遍(客户端测试没有 jsdom,只能静态渲染初始状态)。
 * 钉的是:不抛错;中英文下都没有漏翻成键名的文案;key 输入框是 password + autocomplete=new-password、从不预填;
 * key 来源 / 默认 key 缺失 / 私有网关被关掉这些状态的文案确实画出来了。
 */

const noop = () => undefined;
const resolveNothing = async () => undefined;

const shared: GatewayView = {
  id: 3,
  scope: 'shared',
  name: 'GLM',
  baseUrl: 'https://glm.example.com/api',
  host: 'glm.example.com',
  authType: 'x-api-key',
  hasDefaultKey: false,
  defaultKeyLast4: null,
  enabled: true,
  ownerUserId: null,
  ownerUsername: null,
  modelCount: 2,
  updatedAt: '2026-10-01 05:00:00',
};

const myView = (patch: Partial<MyGatewayView>): MyGatewayView => ({
  ...shared,
  source: 'none',
  personalLast4: null,
  personalSetBy: null,
  canSetPersonalKey: true,
  models: [{ modelId: 'glm-5.2', label: 'GLM 5.2' }],
  ...patch,
});

const privateGateway = myView({
  id: 9,
  scope: 'private',
  name: 'My DeepSeek',
  baseUrl: 'https://ds.example.com',
  host: 'ds.example.com',
  authType: 'bearer',
  hasDefaultKey: true,
  defaultKeyLast4: 'wxyz',
  ownerUserId: 7,
  ownerUsername: 'alice',
  modelCount: 1,
  source: 'personal',
  personalLast4: 'wxyz',
  canSetPersonalKey: false,
});

const privateModel: CatalogEntry = {
  id: 41,
  modelId: 'deepseek-v4',
  label: 'DeepSeek V4',
  vendor: 'deepseek',
  vendorOverride: null,
  description: null,
  contextWindow: 128_000,
  effortLevels: [],
  effortDefault: null,
  recommended: false,
  sortOrder: 0,
  enabled: true,
  isDefault: false,
  lastProbe: null,
  createdAt: '2026-10-01 05:00:00',
  updatedAt: '2026-10-01 05:00:00',
  updatedBy: 7,
  gatewayId: 9,
  allowedUsers: null,
  ownerUserId: 7,
};

const renderAll = () => [
  renderToStaticMarkup(<SharedGatewayRow gateway={shared} users={[{ id: 7, username: 'alice' }]} onChanged={noop} onRemoved={noop} />),
  renderToStaticMarkup(<MyGatewayKeyCard gateway={myView({ id: 0, scope: 'default', source: 'settings' })} me="alice" onGateways={noop} />),
  renderToStaticMarkup(<MyGatewayKeyCard gateway={myView({ source: 'personal', personalLast4: 'abcd', personalSetBy: 'root' })} me="alice" onGateways={noop} />),
  renderToStaticMarkup(<MyGatewayKeyCard gateway={myView({ source: 'none' })} me="alice" onGateways={noop} />),
  renderToStaticMarkup(<MyPrivateGatewaysSection owned={[privateGateway]} mode="active" onGateways={noop} onModels={noop} />),
  renderToStaticMarkup(<MyPrivateGatewaysSection owned={[privateGateway]} mode="readonly" onGateways={noop} onModels={noop} />),
  renderToStaticMarkup(<MyPrivateModelsSection models={[privateModel]} owned={[privateGateway]} mode="active" onModels={noop} />),
  renderToStaticMarkup(<GatewayForm title="t" withKey onSave={resolveNothing} onCancel={noop} onTestUnsaved={async () => ({ ok: true, status: 200, latencyMs: 1, modelCount: 0, sampleModels: [], error: null })} />),
  renderToStaticMarkup(<KeyEntryForm ariaLabel="k" onSave={resolveNothing} onCancel={noop} />),
  renderToStaticMarkup(
    <ModelCatalogEditor
      entry={{ ...privateModel, id: 5, ownerUserId: null, gatewayId: 3, allowedUsers: [7, 8] }}
      defaultSortOrder={10}
      onCancel={noop}
      onSave={resolveNothing}
      gateways={[{ id: 3, name: 'GLM', host: 'glm.example.com', enabled: true, hasDefaultKey: false }]}
      users={[{ id: 7, username: 'alice' }]}
    />,
  ),
  renderToStaticMarkup(
    <ModelCatalogEditor variant="private" entry={null} defaultSortOrder={0} onCancel={noop} onSave={resolveNothing} gateways={[{ id: 9, name: 'My DeepSeek', host: 'ds.example.com', enabled: true, hasDefaultKey: true }]} />,
  ),
];

describe('网关设置页的静态渲染', () => {
  beforeAll(async () => {
    await initI18n();
    await whenFallbackReady();
  });

  test.each(['zh-CN', 'en', 'ja'])('%s:不抛错,没有键名漏出来', async (lang) => {
    await i18n.changeLanguage(lang);
    const html = renderAll().join('\n');
    expect(html).not.toMatch(/gateways\.[a-zA-Z]+\.[a-zA-Z]/);
    expect(html).not.toMatch(/\{\{/);
  });

  test('中文:key 来源、代填人、默认 key 缺失、私有网关被关掉', async () => {
    await i18n.changeLanguage('zh-CN');
    const [row, defaultCard, personalCard, noneCard, , readonlyPrivate, models, , , catalogEditor, privateEditor] = renderAll();
    expect(row).toContain('没有默认 key —— 只有填了个人 key 的人能用');
    expect(defaultCard).toContain('用默认配置(settings.json)');
    expect(personalCard).toContain('用我的 key ····abcd');
    expect(personalCard).toContain('(由 root 代填)');
    expect(noneCard).toContain('没有可用的 key,这个网关上的模型用不了');
    expect(readonlyPrivate).toContain('管理员关掉了私有网关');
    expect(readonlyPrivate).not.toContain('添加私有网关');
    expect(models).toContain('DeepSeek V4');
    expect(models).toContain('My DeepSeek');
    // 目录编辑器:默认网关 + 共享网关两项,可用人员选的是「指定成员」;已选但不在名单里的 #8 照样列出
    expect(catalogEditor).toContain('默认网关(settings.json)');
    expect(catalogEditor).toContain('GLM · glm.example.com');
    expect(catalogEditor).toContain('#8');
    expect(catalogEditor).toContain('已选 2 人');
    // 私有模型编辑器:没有推荐 / 默认 / 可用人员
    expect(privateEditor).toContain('添加私有模型');
    expect(privateEditor).not.toContain('可用人员');
    expect(privateEditor).not.toContain('推荐(选择器置顶)');
  });

  test('key 输入框:password、autocomplete=new-password、不预填', async () => {
    await i18n.changeLanguage('zh-CN');
    const html = renderAll().join('\n');
    const keyInputs = html.match(/<input[^>]*type="password"[^>]*>/g) ?? [];
    expect(keyInputs.length).toBeGreaterThanOrEqual(2);
    for (const input of keyInputs) {
      // HTML 属性不分大小写;React 的服务端渲染原样输出 autoComplete
      expect(input).toMatch(/autocomplete="new-password"/i);
      expect(input).toMatch(/value=""/);
    }
  });
});
