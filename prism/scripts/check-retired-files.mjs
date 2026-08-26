#!/usr/bin/env node
/**
 * 构建前自检:上一轮退役、但升级时可能残留在部署目录里的文件。
 *
 * 起因是一次真实的部署失败。`ThemeContext` 从 `.jsx` 改成 `.tsx` 之后,
 * 服务器上旧的 `.jsx` 没删干净;而 Vite 的 `resolve.extensions` 里
 * **`.jsx` 排在 `.tsx` 前面**,于是 `import ... from '../contexts/ThemeContext'`
 * 稳稳地解析到了那份**旧文件**,报出来的却是一句
 * 「"UI_THEMES" is not exported by ThemeContext.jsx」—— 看着像代码写错了,
 * 其实是目录脏了。
 *
 * 更糟的情况是不报错:旧文件恰好导出了同名东西,构建通过,跑的是上一轮的逻辑。
 *
 * 所以退役文件不能只写在部署文档里靠人记得删。这里在构建前挡一道,
 * 把"解析到哪个文件看运气"变成一句写明了删哪个的错误。
 *
 * 加新条目的规矩:**只登记确实已从仓库删掉的路径**。手上这份树里还存在的
 * 文件出现在这张表里,说明表写错了 —— 下面会一并报出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 路径相对仓库根。注明是哪一轮退役的,方便日后清理这张表。 */
const RETIRED_FILES = [
  // bb —— 主题上下文改成三选一,同时转 TypeScript
  'src/contexts/ThemeContext.jsx',
  // bb —— 深浅开关换成界面主题三选卡片
  'src/shared/view/ui/DarkModeToggle.tsx',
  // at —— 换矢量 logo;bt 又把 logo.png 换回位图,故此处只余深色位图仍是退役态
  'public/brand/logo-dark.png',
  // bt —— logo 换回位图,退役 at 引入的两份矢量图
  'public/brand/logo.svg',
  'public/brand/logo-dark.svg',
  // aa/ac —— 前端设计语言换版
  'src/components/chat/view/subcomponents/ToolGroupContainer.tsx',
  'src/components/sidebar/view/subcomponents/SidebarCollapsed.tsx',
  'src/constants/branding.ts',
];

const stale = RETIRED_FILES.filter((relative) => fs.existsSync(path.join(root, relative)));

if (stale.length > 0) {
  const list = stale.map((relative) => `  ${relative}`).join('\n');
  const rmCommand = stale.map((relative) => path.join(root, relative)).join(' \\\n      ');

  console.error(`
✗ 部署目录里还留着已退役的文件:

${list}

  它们会**遮住**同名的新文件(Vite 的 resolve.extensions 里 .jsx 先于 .tsx),
  轻则构建报一句看不懂的 "is not exported",重则构建通过但跑的是旧逻辑。

  删掉再构建:

    rm -f ${rmCommand}
`);
  process.exit(1);
}
