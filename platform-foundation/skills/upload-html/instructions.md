# upload-html

把一个本地文件发布到服务器，返回可直接访问的对外链接。

> ⚠️ **重要**：文件名含中文等非英文时，**必须先翻译成英文**再发布（见下"执行步骤 2"）。否则脚本只能剥掉非 ASCII，产出 `<id>.html` 或仅含零散英文片段（如 `skill`）的无意义 URL——既不可读又可能误导。

## 使用方式

```
/upload-html <本地文件路径> [英文名]
```

## 执行步骤

1. 用户提供一个本地文件路径（`$ARGUMENTS` 第一项）。
2. **如果文件名含中文等非英文**：先把文件名**翻译成简洁的英文**（保留原意），作为第二个参数传给脚本。例如：
   - `营销诊断Skill汇报-离线版_v2.html` → `marketing-diagnosis-skill-report-offline-v2`
   - `数据周报_2024Q1.html` → `data-weekly-report-2024q1`
   - `用户行为分析.pdf` → `user-behavior-analysis`
3. 运行脚本把文件复制到服务器上传目录（第二参数是翻译后的英文名，**不带扩展名**）：

   ```bash
   bash /home/jovyan/.claude/skills/upload-html/upload.sh "<文件路径>" "<英文名>"
   ```

4. 脚本输出一行，即该文件的**对外访问链接**（纯 ASCII，形如 `https://friday_deployment_14540_algo_agent.gw.friday.17usoft.com/<id>_marketing-diagnosis-...html`，无百分号编码）。
5. 把链接直接返回给用户，不要附加多余解释。

## 翻译要求

- 忠实原意、简洁、用**英文单词**、kebab-case（小写、连字符分隔）。
- **不要音译拼音**：`营销诊断` → `marketing-diagnosis`，而不是 `ying-xiao-zhen-duan`。
- 常见术语：周报→`weekly-report`、汇报→`report`、离线版→`offline`、在线版→`online`、诊断→`diagnosis`、分析→`analysis`、报告→`report`、数据→`data`。
- 纯英文/数字文件名可省略第二参数（脚本直接用原名）。

## 命名规则

- 英文名会被脚本清洗成纯 ASCII kebab-case（小写、非字母数字→`-`、去首尾`-`），加 8 位 hex id 保证唯一，并保留源文件扩展名。
- 撞名时自动再加 8 位 hex 前缀，不覆盖。
- 若未提供英文名：已是 ASCII 的源名原样保留；非 ASCII 名自动剥非 ASCII（纯中文名会退化为 `<id>.html`，可读性差，所以**尽量翻译**）。

## 说明

- 上传目录：`/home/jovyan/prism/public/`
- 该目录由 Prism（8080 端口）通过 `express.static` 在**根路径**实时托管（`/<name>`），文件放进去立即可访问，无需重启服务。**不要用 `/html-files/`**——该路由在本 pod 未挂载，访问返回 404。
- 对外域名固定为 `friday_deployment_14540_algo_agent.gw.friday.17usoft.com`，完整 URL 即 `https://<域名>/<id>_<name>.<ext>`。
