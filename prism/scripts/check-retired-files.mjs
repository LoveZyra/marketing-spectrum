#!/usr/bin/env node
/**
 * 构建前自检:已从仓库删掉、但升级时可能残留在部署目录里的文件。
 *
 * 升级是解包覆盖,删掉的文件不会自己消失。Vite 的 `resolve.extensions` 里 `.jsx` 排在
 * `.tsx` 前面,所以 `ThemeContext.tsx` 旁边残留的旧 `ThemeContext.jsx` 会被
 * `import ... from '../contexts/ThemeContext'` 解析到,报出来的是一句看着像代码写错了的
 * 「"UI_THEMES" is not exported by ThemeContext.jsx」,其实是目录脏了。
 * 更糟的情况是不报错:旧文件恰好导出了同名东西,构建通过,跑的却是旧逻辑。
 *
 * 所以退役文件不能只写在部署文档里靠人记得删。这里在构建前挡一道,
 * 把"解析到哪个文件看运气"变成一句写明了删哪个的错误。
 *
 * 加新条目的规矩:只登记确实已从仓库删掉的路径。手上这份树里还存在的
 * 文件出现在这张表里,说明表写错了 —— 下面会一并报出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 路径相对仓库根。注明退役原因,方便日后清理这张表。 */
const RETIRED_FILES = [
  // 主题上下文改成三选一,同时转 TypeScript
  'src/contexts/ThemeContext.jsx',
  // 深浅开关换成界面主题三选卡片
  'src/shared/view/ui/DarkModeToggle.tsx',
  // 深色 logo 位图已不再使用
  'public/brand/logo-dark.png',
  // logo 用位图,两份矢量图退役
  'public/brand/logo.svg',
  'public/brand/logo-dark.svg',
  // 前端设计语言换版时撤掉的组件
  'src/components/chat/view/subcomponents/ToolGroupContainer.tsx',
  'src/components/sidebar/view/subcomponents/SidebarCollapsed.tsx',
  'src/constants/branding.ts',
  // 技能训练(SkillOpt)整个功能已移除。残留的后果最重:server/tsconfig.json
  // 的 include 是全树通配 + noEmitOnError,部署目录里残留一棵 skillopt 树,tsc 会去
  // 编它,而它 import 的仓库层和审计事件都已经不存在 —— 整个 server 构建挂掉,
  // 错误信息还指向一堆早该不存在的文件。目录用代表性文件登记。
  'server/modules/skillopt/skillopt.service.ts',
  'src/components/skillopt/SkillOptPage.tsx',
  'server/modules/database/repositories/skillopt-runs.db.ts',
  // tools/skillopt 整棵
  'tools/skillopt/adapter.py',
  // 首页用两栏版式,内嵌输入框版式的这三个文件撤掉
  'src/components/chat/view/subcomponents/HomeToolsSection.tsx',
  'src/components/chat/utils/recentSessions.ts',
  'src/components/chat/utils/recentSessions.test.ts',
  // 技能优化三页(优化运行 / 评测 / 版本)接了真数据,"第二期开放"的空态组件退役
  'src/components/skillwhet/view/ComingSoon.tsx',
  // projects 模块的汇总出口没有任何地方 import,撤掉。残留的话它转导出的两个函数已经不存在,
  // server 构建(全树通配 + noEmitOnError)整个挂掉。以后要重新建这个出口,同一次改动里删掉这一条
  'server/modules/projects/index.ts',
];

/*
 * 这张表只有持续维护才有价值:删文件的同一次改动里就把路径登记进来,别等发包检查单。
 * 漏登记的路径不受这道守卫保护,升级残留的旧文件照样可能被构建解析到。
 */

const stale = RETIRED_FILES.filter((relative) => fs.existsSync(path.join(root, relative)));

if (stale.length > 0) {
  const list = stale.map((relative) => `  ${relative}`).join('\n');

  // 给的是挪走而不是删除的命令:部署机上约定不用 rm,挪到 ~/_to_delete/ 并保留目录结构,需要时能原样放回
  console.error(`
✗ 部署目录里还留着已退役的文件:

${list}

  构建会把它们当成源码:可能遮住同名的新文件(Vite 的 resolve.extensions 里 .jsx 先于 .tsx),
  轻则报一句看不懂的 "is not exported",重则构建通过但跑的是旧逻辑;
  也可能引用已经删掉的东西,让 server 编译整个失败。

  挪到 ~/_to_delete/ 再构建(保留目录结构):

    cd ${root}
    D=~/_to_delete/retired_$(date +%Y%m%d_%H%M%S)
    for f in ${stale.join(' ')}; do mkdir -p "$D/$(dirname "$f")" && mv "$f" "$D/$f"; done
`);
  process.exit(1);
}
