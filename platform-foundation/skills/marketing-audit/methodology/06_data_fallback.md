# 06 — 缺数据回退策略

> 当宽表缺少某个关键字段时，宿主 Agent 不要直接报错或让用户补数据；应先尝试本文件定义的 fallback 链。
> 所有 fallback 派生列都会自动写入 `state["data_caveats"]`，下游 finding/narrative 必须在 detail 中标注`[代理指标]`。

## 调用入口

```python
from marketing_audit_skill.snippets.data_fallback import ensure_required_fields

df, caveats = ensure_required_fields(df, mode="all")
state["data_caveats"].extend(caveats)
```

- `mode="all"`：扫描所有规则，能补的都补
- `mode=["is_converted", "pre_is_dormant_user"]`：只检查指定字段
- 单字段：`ensure_field(df, "is_converted")` → `(df, fallback_used, caveat)`

## Fallback 规则表

下表的 `derive` 逻辑都在 `snippets/data_fallback.py` 中实现；新增字段时在 `FALLBACK_RULES` 注册即可。

### 一、标签类（影响 CVR / 诊断规则评估）

| 缺失字段 | Fallback 链 | 影响 |
|---|---|---|
| `is_converted` | ① `convert_time IS NOT NULL` ② 提示用户 | 全部失败 → 跳过所有 CVR 类诊断规则评估；`finding_richness` 折扣 0.5 |

### 二、产品偏好类（influence user_segment）

| 缺失字段 | Fallback 链 |
|---|---|
| `pre_top_interest_product` | 已有 `pre_hotel/flight/train/scenic_depth` 取最大者；都缺失则取 `pre_browse_*` 中第一个 =1 的；全无 → '无浏览' |
| `pre_is_cross_category` | `sum(pre_browse_hotel, pre_browse_flight, pre_browse_train, pre_browse_scenic, pre_browse_car, pre_browse_bus) > 1` |
| `pre_mkt_product_browse_match` | `pre_top_interest_product == activity_product_name` |

### 三、平台与活跃度（influence platform_behavior）

| 缺失字段 | Fallback 链 |
|---|---|
| `pre_primary_platform` | argmax(pre_app_event_cnt, pre_wechat_event_cnt, pre_yilong_event_cnt) |
| `pre_is_cross_platform` | 同时存在 ≥2 个 `pre_*_event_cnt > 0` |
| `pre_events_per_hour` | `pre_total_event_cnt / max(pre_active_span_min/60, 1/60)` |
| `pre_first_active_period` | `pre_first_active_hour` → 6-11:上午 / 12-17:下午 / 18-22:晚上 / else:深夜 |
| `pre_is_dormant_user` | `pre_total_event_cnt == 0`（触达前无任何历史行为） |

### 四、行为路径（influence path_quality）

| 缺失字段 | Fallback 链 |
|---|---|
| `pre_is_marketing_first` | `pre_first_touch_model == '营销'`；若缺失则从 `pre_path_model_seq` 取首节点 |
| `pre_is_marketing_last` | `pre_last_touch_model == '营销'`；若缺失则从 `pre_path_model_seq` 取末节点 |
| `pre_search_match_target` | `pre_last_search_product == activity_product_name` |

## fallback 触发后的 caveat 形态

```json
{
  "field":      "is_converted",
  "issue":      "原列缺失",
  "fallback":   "complete_time IS NOT NULL",
  "n_derived":  8421,
  "n_nan_left": 13,
  "impact":     "CVR 类 finding 改用派生标签；与真实成单可能有 <2% 偏差"
}
```

下游 finding 的 detail 必须包含`[代理指标]` 标记，否则 self_critique 会报 business_coherence warning。

## 完全无法回退时的策略

- 单字段无法回退 → 在 `state.skipped_dimensions` 标注该维度跳过原因
- `confidence.domain_coverage` 自动按缺失维度数折扣（每跳过一维扣 1/6），影响最终 `data_coverage` 的 domain 部分（占 50%）
- 在最终报告 `data_caveats` 显著位置罗列

## 与 adhoc_synthesis 的关系

若某个 finding 想引用 `pre_path_model_seq` 派生的指标，但派生逻辑不在本文件 fallback 表里（例如想要"营销->主流程->营销->主流程"的特殊模式计数），不要硬塞到 fallback；应进入 `methodology/07_adhoc_tools.md` 的临时工具流程。
