# feedback/ —— 跨版本持久数据，**不要删、不要打进安装包**

本目录存放跨 job 沉淀的账本，是 skill 里唯一「运行中产生、且必须活过升级」的数据：

| 文件 | 写入方 | 说明 |
|---|---|---|
| `issues.jsonl` | `snippets/issue_ledger.py` | 问题账本：字段缺失/阈值算不出/validator warn/用户与 Agent 反馈 |
| `adhoc_history.jsonl` | `snippets/adhoc_registry.py` | ad-hoc 工具使用历史（2026-08-12 从 `~/.marketing_audit_skill/` 迁入） |

## 三条必须守住的规矩

1. **打包排除**：用 `scripts/pack_skill.sh` 打包（已带 `--exclude` 与自检）。
   手工打包务必加 `--exclude='feedback'`，否则安装即覆盖账本。
2. **不进 git**：`.gitignore` 已忽略 `feedback/*.jsonl`。
   两边都在追加的 jsonl 进版本库必然冲突且无法人工消解。
   **要进 git 的是 `cli issues report --out` 产出的 md 评审报告，不是原始 jsonl。**
3. **重装先备份**：`scripts/install_skill.sh` 会自动备份并按行合并回来。
   手工重装前请先 `cp -a feedback /tmp/`，装完 `cat` 回去再跑 `cli issues compact`。

## 常用命令

```bash
python3 cli.py issues list                       # 看当前账本
python3 cli.py issues report --since 30d --out review.md   # 出评审报告
python3 cli.py issues resolve --key <issue_key> --status promoted --note "fixNN 已修"
python3 cli.py issues compact                    # 折叠去重（离线操作）
```

只读部署下本目录不可写时，账本会自动降级到 `~/.marketing_audit_skill/` 并打 warning；
可用 `MA_FEEDBACK_DIR` 指定可写目录。
