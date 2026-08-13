# ma-api 部署说明

营销诊断 HTTP 服务。**常驻进程，改完必须重启。**

- 线上路径：`~/prism/ma-api-mode/`
- 附带：`restart_prism.sh` 由 `install.sh` 自动拷到上一级 `~/prism/`

## 两个入口，都在用

| 入口 | 文件 | 谁拉起 | 联调 runner |
|---|---|---|---|
| **方案 C**（默认） | `ma_api_c.py` | Prism 自启（`PRISM_MA_API_AUTOSTART`） | `run_real_c.sh` |
| **方案 B** | `ma_api_b.py` | 手工 | `run_real_b.sh` |

`ma_core.py`（HTTP 层 + 任务存储 + `/result` 公开契约）和 `ma_pipeline.py`（十步主链）
两条路共用。改这两个文件 = 同时影响 B 和 C。

## 装

```bash
tar xzf ma-fix<N>.tar.gz -C ~/prism/ma-api-mode/
bash ~/prism/ma-api-mode/install.sh      # 备份 → 覆盖 → 语法自检 → 六套回归
bash ~/prism/restart_prism.sh            # 不重启不生效
```

`install.sh` 会跑六套回归（约 31 / 166 / 172 / 109 / 59 / 22 条），任何一套挂了自己 `exit 1`，
这时**先别重启服务**。

## 出参契约

`/result` 是**白名单投影**（`ma_core.public_rules()`），`rules[]` 逐条六个字段：

```
name / finding_id / sql_filter / filter_zh / direction / suggestion
```

skill 侧加多少字段都到不了调用方，只会躺在 `jobs/<id>/meta.json` 里 —— 要新增出参字段，
**这里和 skill 侧必须同批改**。`regress_contract.py` 守着这条（字段数、顺序、内部键不外泄）。

## 配套关系

`filter_zh` 的值由 skill 侧 `crowd_translator` 产出，所以 **ma-fix19 必须和 ma-skill-fix29 一起装**，
否则这一列全是空串（不报错，也没内容）。
