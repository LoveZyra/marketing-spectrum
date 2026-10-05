import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MODEL_VENDORS, detectModelVendor } from '../../../shared/modelVendors';

/**
 * hn(方案 v3 B4 / B6 / B7)前端接线 —— 客户端测试跑在 node 环境(挂不起组件),读源码与静态文件钉住:
 * 图标文件就是方案里核过 md5 的那 9 个、单色图走遮罩、选择器 / chip / 设置页 / SkillWhet 都接上了目录。
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const readBytes = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)));

/** 方案 v3 B6 表:@lobehub/icons-static-svg 1.95.1,重新从 npm 取包核过。 */
const ICON_MD5: Record<string, string> = {
  'claude-color.svg': '9e17036145c6f918d950b9ba9435f5b7',
  'openai.svg': '0f50ad4f3a6548123711a4868e8bbbc8',
  'gemini-color.svg': '839c46fa32b57506caa28fa8a4766016',
  'grok.svg': '167c966c5d24ced5255c348653b48429',
  'zai.svg': '3eea0edc67216d2d579d5235b4ca3f44',
  'deepseek-color.svg': '24511b244253f5d0a6b78bd2b3c3b8d3',
  'qwen-color.svg': '8c440ce203d62428843eceaa7b474e58',
  // 实施时改用单色版:彩色版的主字形是白色,浅色主题下看不见(截图核过)
  'kimi.svg': '255424137b3ef3dbcb545753f6480547',
  'doubao-color.svg': 'f2137c7dca53570370711a1e6f8a3935',
};

describe('B6 厂商图标', () => {
  it('9 家的图标文件都在 public/model-icons/,md5 与方案里核过的一致', () => {
    expect(MODEL_VENDORS).toHaveLength(9);
    for (const vendor of MODEL_VENDORS) {
      const bytes = readBytes(`../../../public/model-icons/${vendor.icon}`);
      expect(createHash('md5').update(bytes).digest('hex'), vendor.icon).toBe(ICON_MD5[vendor.icon]);
    }
  });

  it('单色标记与文件内容一致:fill="currentColor" 的才走遮罩', () => {
    for (const vendor of MODEL_VENDORS) {
      const svg = readBytes(`../../../public/model-icons/${vendor.icon}`).toString('utf8');
      expect(svg.includes('fill="currentColor"'), vendor.icon).toBe(vendor.mono);
    }
    const icon = read('./ModelVendorIcon.tsx');
    expect(icon).toMatch(/if \(info\.mono\)/);
    expect(icon).toMatch(/maskImage: mask/);
    expect(icon).toMatch(/bg-current/);
  });

  it('NOTICE 带上 lobe-icons 的 MIT 全文', () => {
    const notice = read('../../../NOTICE');
    expect(notice).toMatch(/@lobehub\/icons-static-svg 1\.95\.1/);
    expect(notice).toMatch(/Copyright \(c\) 2023 LobeHub/);
    expect(notice).toMatch(/THE SOFTWARE IS PROVIDED "AS IS"/);
  });

  it('共用识别规则前后端是同一份文件', () => {
    expect(detectModelVendor('glm-5.2')).toBe('glm');
    const server = read('../../../server/modules/providers/list/claude/claude-model-catalog.service.ts');
    expect(server).toMatch(/shared\/modelVendors\.js/);
  });
});

describe('B4 选择器 / chip / 设置页', () => {
  it('/models 弹窗用新选择器,拿到当前上下文用量', () => {
    const modal = read('../chat/view/subcomponents/CommandResultModal.tsx');
    expect(modal).toMatch(/<ModelPickerContent/);
    expect(modal).toMatch(/contextUsedTokens=\{contextUsedTokens\}/);
    expect(modal).not.toMatch(/function ModelsContent\(/);
    const chat = read('../chat/view/ChatInterface.tsx');
    expect(chat).toMatch(/contextUsedTokens=\{contextUsedTokens\}/);
    expect(chat).toMatch(/activeModelLabel=\{activeModelLabel\}/);
    expect(chat).toMatch(/activeModelVendor=\{activeModelVendor\}/);
  });

  it('选择器:推荐 / 按厂商分组 / 别名组收起;超压缩线的行有提示;实测别名只给 root', () => {
    const picker = read('../chat/view/subcomponents/ModelPickerContent.tsx');
    expect(picker).toMatch(/commandResult\.models\.recommended/);
    expect(picker).toMatch(/for \(const vendor of MODEL_VENDORS\)/);
    expect(picker).toMatch(/commandResult\.models\.aliasGroup/);
    expect(picker).toMatch(/used >= compactLine/);
    expect(picker).toMatch(/isRoot && aliasExpanded/);
  });

  it('输入框 chip 认得出厂商就画图标,目录条目显示名字', () => {
    const composer = read('../chat/view/subcomponents/ChatComposer.tsx');
    expect(composer).toMatch(/<ModelVendorIcon vendor=\{activeModelVendor\}/);
    expect(composer).toMatch(/const chipModelName = activeModelLabel \|\| activeModelRealName \|\| activeModel;/);
  });

  it('设置页拆成模型目录 + 别名两块;目录改了广播给对话页重拉', () => {
    const tab = read('../settings/view/tabs/ModelMappingSettingsTab.tsx');
    expect(tab).toMatch(/<ModelCatalogSection \/>/);
    const api = read('../settings/view/tabs/model-catalog/modelCatalogApi.ts');
    expect(api).toMatch(/MODEL_CATALOG_CHANGED_EVENT = 'prism:model-catalog-changed'/);
    const provider = read('../chat/hooks/useChatProviderState.ts');
    expect(provider).toMatch(/window\.addEventListener\('prism:model-catalog-changed'/);
  });

  it('切模型被拒时把服务端的原因给用户看(不再是一句英文)', () => {
    const provider = read('../chat/hooks/useChatProviderState.ts');
    expect(provider).toMatch(/typeof body\.error === 'string' && body\.error \? body\.error/);
  });
});

describe('B7 SkillWhet 从目录选模型', () => {
  it('训练表单:不再写死三个别名;按真名判评估 ≠ 提议;非 root 只列允许的', () => {
    const form = read('../skillwhet/view/RunNew.tsx');
    expect(form).not.toMatch(/<datalist id="skillwhet-models">/);
    expect(form).toMatch(/<SkillWhetModelSelect/);
    expect(form).toMatch(/realOf\(evalModel\) === realOf\(slowModel\)/);
    expect(form).toMatch(/budget\?\.allowedModels/);
  });

  it('夜训设置:模型下拉同一个组件,root 不限', () => {
    const nightly = read('../skillwhet/view/NightlyControl.tsx');
    expect(nightly).not.toMatch(/\['haiku', 'sonnet', 'opus'\]/);
    const fields = nightly.slice(nightly.indexOf('function NightlyModelFields('));
    expect(fields).toMatch(/<SkillWhetModelSelect value=\{draft\[key\]\}/);
    expect(fields).toMatch(/allowed=\{null\}/);
  });
});
