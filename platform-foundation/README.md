# platform-foundation —— Agent 侧部署源

> 父目录 `marketing-spectrum` 已经把业务说完了，这里只说「这是哪一部分」——
> 平台的地基：Agent 用的能力（skills）、驱动它的服务（services）、按它跑的流程（jobs）。

装到 ma_server 这台机器上的全部源码：**skill、常驻服务、固定流程**三类。
目录按**装到哪儿**分，不按业务线分 —— 决定一个文件怎么部署、改完要不要重启的，
是它的部署目标，不是它属于哪条业务。

```
skills/     → ~/.claude/skills/<同名目录>/     目录名必须等于 SKILL.md 里的 name
services/   → 常驻进程，改完必须重启
jobs/       → 跑一遍就结束的流程
dist/       → 发布包（gitignore，线上回滚靠 .bak_<时间戳>，不靠这里）
docs/       → 跨组件的方案、复盘、接口说明
```

## 部署映射表

改任何东西之前先看这张表。

| 本地路径 | 线上路径 | 怎么装 | 改完要做什么 |
|---|---|---|---|
| `skills/marketing-audit/` | `~/.claude/skills/marketing-audit/` | `scripts/install_skill.sh <包>` | 无需重启，下一单生效 |
| `skills/hdfs-data/` | `~/.claude/skills/hdfs-data/` | 直接覆盖 `scripts/` | 无 |
| `skills/schedule-task/` | `~/.claude/skills/schedule-task/` | `bash install.sh`（幂等，不动已有任务与 crontab） | 无 |
| `skills/onesql/` | `~/.claude/skills/onesql/` | 直接覆盖 | 无 |
| `skills/html-edit-mode/` | `~/.claude/skills/html-edit-mode/` | 直接覆盖 | 无 |
| `skills/upload-html/` | `~/.claude/skills/upload-html/` | 直接覆盖 | 无 |
| `services/ma-api/` | `~/prism/ma-api-mode/` | 见 `services/ma-api/DEPLOY.md` | **必须** `bash ~/prism/restart_prism.sh` |
| `jobs/private-domain-diagnosis/` | `/home/jovyan/营销诊断/` | 直接覆盖三个 .py | 无（手工按活动触发） |

**不纳管**：`~/schedule_task/<任务名>/` 下的 cron 任务实例（含 `tasks/prompt.md`）只存在于服务器上。
仓库只管 `skills/schedule-task/` 这个框架本身。任务照跑，改了不留痕 —— 这是明知的取舍。

## 一个新文件该放哪

按顺序问，第一个「是」就落位：

1. 会被 `~/.claude/skills/` 装载吗？→ `skills/<name>/`，目录名必须等于 `SKILL.md` 的 `name`
2. 是一直开着的进程、改完要重启吗？→ `services/<name>/`
3. 跑一遍就结束吗（cron 拉起或手工敲都算）？→ `jobs/<name>/`

都不是 → `docs/`。触发方式（cron / 手工 / API）写在 `JOB.md` 第一行，**不为它再开一层目录** ——
触发方式会变，部署位置不会。

## 不进仓库的东西

`.gitignore` 已配。四类：

- **运行时产物**：`__pycache__/`、`runs/`、`logs/`、`work/`
- **发布包**：`dist/`、`*.tar.gz`
- **跨版本持久数据**：`skills/marketing-audit/feedback/*.jsonl` —— 问题账本，
  `install_skill.sh` 有专门的备份合并逻辑，**进了包就会覆盖线上**
- **机器特定的环境快照**：`skills/schedule-task/_shared/` 下的
  `runtime_env.sh`、`bigdata_env.sh`、`claude_bin.env`、`crontab.txt` ——
  由 `capture_env.sh` / `preflight.sh` / `add_task.sh` 在线上生成，换台机器就失效

## `_to_delete/`

Cowork 的挂载盘不允许删文件，所有删除动作一律先 `mv` 到这里，**由人工在资源管理器清空**。
当前躺着：旧版 `schedule_task`、`marketing-audit/dist` 旧包（含一个 10MB 的）、传输用的 tar。

## git 状态（2026-08-13）

基线提交 `e6eab5d`（重构前现状存档，124 个文件）已在。但**后续提交要在 Windows 里做** ——
Cowork 的挂载盘不允许 unlink，git 留下了删不掉的锁文件。先在资源管理器里删掉：

```
.git/HEAD.lock
.git/objects/maintenance.lock
.git/objects/*/tmp_obj_*
```

再 `git add -A && git commit -m "refactor: 按部署目标重组目录"` 即可。
