---
name: html-edit-mode
description: Add in-browser WYSIWYG editing to HTML reports. Supports text editing (bold/color/size), block style editing (background/border/radius/padding), undo (single + all), and HTML export with real browser download. Use when the user asks to make an HTML file editable, add editing features to a report, or wants to embed edit capability into generated HTML reports.
---

# HTML Edit Mode Skill

> 为静态 HTML 文件添加浏览器内所见即所得编辑功能。
> 支持文字格式化 + 块样式编辑 + 撤销 + 导出。
> 两种使用模式：A) 为已有 HTML 注入编辑功能；B) 在报告生成工作流中嵌入编辑功能。

---

## 功能概述

| 功能 | 说明 |
|------|------|
| ✏️ 文字编辑 | `contenteditable` 切换，点击文字即可编辑 |
| **B** 加粗 | `document.execCommand('bold')` |
| 🎨 字体颜色 | 8 预设色块 + 原生 color picker |
| 🔤 字号 | 下拉选择 11px/12px/14px/16px/18px/20px/24px/28px/36px |
| 🧱 块样式编辑 | 背景色、边框颜色/宽度/样式、圆角、内边距 |
| ↩️ 撤销 | Alt+Click 单项撤销、全部撤销按钮 |
| 📥 导出 HTML | Blob URL + about:blank 辅助页实现真正的浏览器下载 |
| 💾 自动保存标记 | `data-orig` / `data-edited` 追踪修改状态 |

---

## 架构

编辑功能由三个独立组件组成，注入到目标 HTML 中：

```
目标 HTML 文件
├── <style>  ← 注入 edit-mode.css（编辑模式样式）
├── <body>
│   ├── edit-toolbar   ← 注入 edit-mode-toolbar.html（工具栏）
│   ├── edit-float-bar ← 注入（浮动文字格式栏）
│   ├── edit-style-panel ← 注入（块样式面板）
│   └── edit-toast     ← 注入（提示 toast）
│   └── <script>       ← 注入 edit-mode.js（编辑逻辑）
```

**核心机制：**

- **文字编辑**：通过 `TreeWalker` + `NodeFilter` 标记 `[data-editable]` 元素。点击时设置 `contenteditable="true"`，保存 `data-orig` 原内容。编辑后比对 `data-orig` vs `innerHTML`，变化则标记 `data-edited`。
- **块样式**：`[data-orig-style]` 存储首次编辑前的 `style.cssText`（JSON）。`data-style-edited` 标记块样式已修改。
- **撤销**：`undoOne()` / `undoAll()` 同时处理 `data-edited`（文字）和 `data-style-edited`（块样式）。
- **导出**：`doExport()` 克隆 DOM → 清除编辑标记属性 → 通过 `about:blank` 辅助页创建同源 Blob URL → 触发 `<a download>`。

---

## 模式 A：为已有 HTML 注入编辑功能

### 步骤

1. **读取** 目标 HTML 文件和三个 asset 文件（`assets/edit-mode.css`、`assets/edit-mode-toolbar.html`、`assets/edit-mode.js`）
2. **注入 CSS**：在目标 HTML 的 `</style>`（最后一个）之前插入 edit-mode.css 内容
3. **注入 HTML**：在 `<body>` 标签之后立即插入 edit-mode-toolbar.html 内容
4. **注入 JS**：在 `</body>` 之前插入 edit-mode.js 内容（放在所有已有 `<script>` 之后）
5. **保存**为新文件（建议命名为 `原文件名_可编辑.html`）

### 注入位置示意

```html
<!-- 原始文件结构 -->
<html>
<head>
  <style>/* 原始样式 */</style>
  <!-- ↑ 在这里插入 edit-mode.css -->
</head>
<body>
  <!-- ↑ 在这里插入 edit-mode-toolbar.html -->
  <div class="content">...</div>
  <script>/* 原始脚本 */</script>
  <!-- ↑ 在这里插入 edit-mode.js（所有脚本之后） -->
</body>
</html>
```

### 配置项（修改 edit-mode.js 中的常量）

| 变量 | 位置 | 说明 | 默认值 |
|------|------|------|--------|
| `STYLE_BLOCKS` | JS 顶部 | 可进行块样式编辑的 CSS class 名 | `['masthead','summary','summary-card','section-overview','insight','chart-box','trend-card','rec-box','trend-action','conclusion','action-box','conc-card']` |
| `TEXT_COLORS` | JS 顶部 | 文字颜色预设 | `['#1a1a1a','#c41e3a','#27ae60','#2980b9','#f39c12','#e74c3c','#555555','#888888']` |
| `BG_COLORS` | JS 顶部 | 背景色预设 | `['#ffffff','#fafafa','#faf8f5','#fef5f5','#f4fdf6','#fffdf5','#e3f2fd','#1c1c1c','#f5f3ef']` |
| `BD_COLORS` | JS 顶部 | 边框色预设 | `['#cccccc','#eeeeee','#dddddd','#c41e3a','#27ae60','#f39c12','#e74c3c','#2980b9','#1a1a1a']` |
| `EDIT_TAGS` | JS 中 | 可编辑的 HTML 标签白名单 | `SPAN, STRONG, EM, A, H1-H6, P, LI, TD, TH, DIV...` |
| `STRUCTURAL` | JS 中 | 不可编辑的结构性 class 名 | `['insight','chart-box','chart-canvas',...]` |

---

## 模式 B：嵌入报告生成工作流

当 `report-agent` 生成 HTML 报告时，在最终输出中直接包含编辑功能。

### 工作流集成方式

在 report-agent 的渲染阶段，将三个 asset 文件内容内联到输出 HTML 中：

```
report-agent 渲染流程:
  1. 生成报告 HTML 结构
  2. 在 </style> 前内联 assets/edit-mode.css
  3. 在 <body> 后内联 assets/edit-mode-toolbar.html
  4. 在 </body> 前内联 assets/edit-mode.js
  5. 输出最终 HTML 文件
```

### 配置：根据报告内容调整 STYLE_BLOCKS

不同报告可能使用不同的 CSS class 命名。在嵌入前，根据报告实际使用的 class 名修改 `STYLE_BLOCKS` 数组。

例如：
```javascript
// 报告使用 .card 作为容器 → 添加到 STYLE_BLOCKS
var STYLE_BLOCKS = ['masthead','summary','card','section-overview','insight',
  'chart-box','trend-card','rec-box','conclusion','action-box'];
```

将报告中最外层的视觉容器 class 名加入 `STYLE_BLOCKS`，将内部子结构 class 名加入 `STRUCTURAL`。

---

## Asset 文件说明

| 文件 | 大小 | 说明 |
|------|------|------|
| `assets/edit-mode.css` | ~280 行 | 工具栏、浮动栏、样式面板、编辑态高亮的全部 CSS |
| `assets/edit-mode-toolbar.html` | ~75 行 | 工具栏 + 浮动文字格式栏 + 块样式面板 + Toast 的 HTML |
| `assets/edit-mode.js` | ~1030 行 | 编辑模式全部 JS 逻辑（IIFE 封装，不污染全局） |

三个文件均可独立使用，无外部依赖。

---

## 兼容性

- ✅ Chrome / Edge / Firefox / Safari（现代浏览器）
- ✅ `file://` 协议（导出使用 about:blank 绕过跨域限制）
- ✅ ECharts 图表（canvas 被排除在编辑范围外）
- ✅ 响应式布局（float bar 跟随滚动/窗口调整重新定位）
- ⚠️ 依赖 ES5 兼容 API（`querySelector`、`classList`、`TreeWalker`、`NodeFilter`）

---

## 验证清单

编辑功能注入后，依次验证：

- [ ] 点击「✏️ 开启编辑」→ 工具栏显示完整 → 悬停文字元素出现虚线高亮
- [ ] 点击文字 → `contenteditable` 激活 → 浮动格式栏出现（B/字号/颜色）→ 修改文字 → 点击别处保存 → 修改计数+1
- [ ] 选中文字 → 点击 B → 加粗生效 → 选颜色 → 改色生效 → 选字号 → 字号变化生效
- [ ] 开启「🎨 块样式」→ 悬停块 → 紫色虚线 → 点击块 → 样式面板出现 → 修改背景色/边框/圆角 → 即时生效
- [ ] Alt+Click 已修改项 → 单项撤销成功 → 计数-1
- [ ] 点击「↩️ 全部撤销」→ 所有文字和样式修改还原
- [ ] 点击「📥 导出 HTML」→ 打开下载辅助页 → 点击下载 → 浏览器下载 HTML 文件 → 打开确认无编辑 UI 残留
- [ ] 关闭编辑模式 → 所有编辑 UI 和标记清理完毕
