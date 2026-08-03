# 优化方案:prepare OOM(2026-08-03,activity 1000344 千万行级)

## 一、问题定性(全部实测,非推断)

单活动切片 **1320 万行 × 250 列**,zstd 落盘 4.0G。`cli.py` 用 `pd.read_parquet` 整表载入:

| 量 | 数值 | 来源 |
|---|---|---|
| pandas 稳态 | **60~65 GiB** | 1/7 文件实测 8.6G×7;现场 compute-thresholds RSS 65.6G 印证 |
| 转换期峰值 | **~110-120 GiB** | Arrow 表(~56G)与 pandas 帧(~60G)转换期双持 |
| 容器配额 | **128 GiB**(宿主机 1TB) | memory.limit_in_bytes=137438953472 |
| 历史峰值 | **顶格**(limit+12KB) | memory.max_usage_in_bytes=137438965760,撞顶实锤 |
| 常驻邻居 | Spark JVM 4~10G + 5 个闲置 claude 进程 ~2G + 服务本体 | ps 实测;当时无模型训练进程 |

结论:**峰值 ~116G + 常驻 ~10G ≈ 顶格**,余量仅几个 G,prepare 的转换峰值先碰头被 OOM killer 杀掉(exit=-9,两次分别 138s/128s,均死在装载阶段,统计/模型分析代码未执行到)。`dtype_backend="pyarrow"` 实测仅省 1.1 倍(列以数值为主),不采用。

pull 侧已由分区表 + fix15(repartition)解决:30 分钟超时 → 3 分钟,403 task 并行扫描、7 文件写出。

## 二、方案(按层,标注优先级)

### 代码层(fix16,主攻)

**fix16-a 削峰(P0,当天可验)**:`cli.py::_load_dataframe` 的 parquet 分支改为

```python
import pyarrow.parquet as pq
tbl = pq.read_table(path)
return tbl.to_pandas(self_destruct=True, split_blocks=True)   # 转换期逐列释放 Arrow 缓冲
```

峰值 116G → **~65G**,余量从几个 G 变成 60G+。`_load_dataframe` 是公共函数,prepare / compute-thresholds 等所有子命令一起受益。失败回退老读法(梯度写法),风险低。

**fix16-b 列裁剪(P0,根治)**:`ma_pipeline.py::HiveSource.pull` 给 hdfs_get 传 `--columns`(脚本原生支持):

- 第一步:`MA_PULL_COLUMNS` 环境变量手拍列清单,立刻可验;
- 第二步:从 `marketing-audit/feature_schema/feature_registry.yaml` 自动取诊断用列,免维护。

250 列 → 诊断实际用的几十列:稳态 65G → **十几 G**(线性),prepare/compute-thresholds 的 CPU(实测 602%×7min 级)同步线性降。裁列只影响诊断链路自己拉的 data.parquet,**不动 Hive 表,模型训练侧无感**。

### 数据层(可选,与 fix16-b 收益重叠)

数仓侧出窄表/预聚合:若列清单长期稳定,让 ETL 直接产诊断专用窄表,连 `--columns` 都省。动上游,优先级低,fix16-b 跑顺后再议。

### 资源/运维层(兜底与卫生)

1. 容器 128G → 192/256G(宿主机 1TB,配置层面一句话):纯兜底,fix16-a+b 落地后非必需;
2. 清理 7 月下旬起闲置的 5 个 claude 交互进程(~2G,pts/10~31);
3. 若未来模型训练任务与诊断同容器,错峰或独立 cgroup——余量账要按"诊断峰值 + 训练常驻"算。

### 观测层(防回归)

1. 服务环境 `export PYTHONUNBUFFERED=1`:子进程再被杀时日志保留死前最后一行;
2. 备忘(fix17 顺手做):run_cmd 对负 returncode 标注信号名(-9=SIGKILL 疑似 OOM);pull 完打点 data.parquet 体积与行数,"数据多大→有没有被杀"一眼可对。

## 三、预期收益

| 措施 | 装载峰值 | 稳态 | 预期结果 |
|---|---|---|---|
| 现状 | ~116G | 60-65G | prepare 被杀 → degraded 骨架报告 |
| +fix16-a | **~65G** | 60-65G | 千万行单大概率过 prepare,出真报告 |
| +fix16-b | **~15-20G** | 十几 G | 稳过,且统计计算快数倍,不惧邻居 |
| +扩容(可选) | — | — | 极端活动/多任务并发的兜底 |

## 四、落地顺序与依赖

1. 用户提供:**服务器现行 `cli.py`**(必须,不盲改)+ `feature_registry.yaml`(或手拍 `MA_PULL_COLUMNS` 列清单);
2. 打包 fix16(cli.py 照 hdfs_get 惯例随包单独拷;ma_pipeline.py 走 install.sh);
3. 重跑 1000344 验证:`watch -n2 'grep VmRSS /proc/$(pgrep -f "cli.py prepare")/status'` 盯峰值;预期 prepare 通过、`degraded=false`、报告为 skill 正版全量文案;
4. 回归照旧:install.sh 内五套全过再重启。

---
生成:2026-08-03。数字来源:job_20260803_214025_d78834 实测(1/7 文件内存实验、ps/cgroup 现场、max_usage 峰值)。配套阅读:《诊断_20260803_activity1000344.md》《拉数瓶颈_20260803_activity1000177.md》《处置方案_20260803_activity1000344.md》。
