# 01 — 活动配置诊断 (Step 0)

## 目标

不分析用户行为数据，只分析**活动本身的配置合理性**：目标是否合理、人群定向是否精准、激励设计是否有效、渠道组合是否匹配。识别"先天设计缺陷"作为后续 6 维度诊断的参照系，并生成 `context_for_agents` 注入给各维度 Agent。

---

## Step 0 触发时机

`cli prepare` 执行完成后，`state.campaign_meta` 已由 `--auto-meta` 或 `--meta` 参数填充。Step 0 的任务是：

1. **读取已有的 `campaign_meta`**，确认哪些字段已自动推断
2. **一次性向用户补问**无法从数据推断的字段（仅问一次，不逐项追问）
3. **运行先天设计缺陷自检**
4. **写入 `state['campaign_profile']`**

---

## 字段分类：自动推断 vs 需要补问

### A. `--auto-meta` 已自动推断的字段（无需再问用户）

| 字段 | 来源列 | 注意事项 |
|---|---|---|
| `campaign_name` | `activity_name` 众数 | ⚠️ 可能是页面名而非活动名，需向用户确认是否准确 |
| `campaign_id` | `activity_id` 众数 | — |
| `target_products` | `activity_product_name` 唯一值 | ⚠️ **常见陷阱**：该字段存的是页面名（如"特价机票业务总览"），不是品类名（"机票"）。需要用户确认或手动修正为 ["机票"] |
| `target_channels` | `activity_channel_std` 唯一值 | — |
| `inferred_platform` | `pre_primary_platform` 众数 | 仅展示参考，**不触发数据过滤**（只有 `--meta` 显式传 `target_platform` 才过滤） |
| `start_date` / `end_date` | `touch_date` 范围 | — |

### B. 无法从数据推断、需要用户补充的字段

| 字段 | 用途 | 缺失时处理方式 |
|---|---|---|
| `campaign_type` | 大促/召回/新客获取/复购/节日活动 | 默认 "大促" |
| `target_audience` | 人群定向描述 | 标注"元数据缺失，人群定向维度降级" |
| `discount_type` | 满减/直减/折扣/红包/积分 | 从数据推断或标注"未知" |
| `discount_value` | 优惠具体内容，如"满300减30" | 无则跳过激励设计判定 |
| `coupon_validity_h` | 优惠券有效期（小时） | 无则跳过有效期判定 |
| `target_cvr` | 本次活动目标转化率 | 无则无法做目标偏差分析 |
| `benchmark_cvr` | 同类活动历史基准 | 无则无法判断目标是否激进 |

---

## 执行流程

### 第一步：读取并展示已有 meta，确认准确性

```python
# 读取 auto-meta 已填字段
cm = state.get("campaign_meta") or {}
print(f"已识别：活动「{cm.get('campaign_name')}」")
print(f"  渠道：{cm.get('target_channels')}")
print(f"  日期：{cm.get('start_date')} ~ {cm.get('end_date')}")
print(f"  目标品类（原始）：{cm.get('target_products')}  ← 请确认是否正确")
```

### 第二步：一次性补问 B 类字段

**Agent 提问格式**（一条消息，不逐项追问）：

> 已从数据自动识别：活动「{campaign_name}」，渠道 {target_channels}，日期 {start_date}，平台 {inferred_platform}。
>
> **请确认一处可能不准的字段**：目标品类当前为「{target_products}」（来自数据页面名），请问实际目标品类是什么？（如：机票、酒店、火车票）
>
> **以下字段可选补充**，不填则跳过对应判定：
> 1. 活动类型（大促/新客获取/召回/复购，默认：大促）
> 2. 目标人群描述（例："近30天有机票浏览但未下单"）
> 3. 优惠形式与金额（例："满300减30券"）
> 4. 优惠券有效期（小时，例：24）
> 5. 目标转化率（例：15%）
> 6. 历史基准转化率（例：12%，用于判断目标是否合理）
>
> 全部跳过也可以，诊断将基于数据推断。

**关键约束**：
- 只问一次，不逐项追问
- 用户部分回答也接受，缺失字段写 null 并在 `design_issues` 中标注
- 用户明确拒绝提供 `target_products`（包括无法确认品类）→ 终止诊断，记录原因

### 第三步：运行先天设计缺陷自检

对照以下清单，逐条检查已有的 `campaign_meta`：

| # | 缺陷模式 | 触发条件 | 严重度 | 维度 |
|---|---|---|---|---|
| 1 | 优惠门槛远高于目标品类客单价 | 如火车票活动满200减20 | high | 激励设计 |
| 2 | 优惠券有效期过短 | `coupon_validity_h < 6` 且目标品类决策周期通常 > 1h | high | 激励设计 |
| 3 | 目标人群过宽（全量推送） | `target_audience` 含"全量/全部用户"或为空 | mid | 人群定向 |
| 4 | 渠道与平台不匹配 | `target_platform=微信` 但 `target_channels` 主投 push（push 在微信无效） | high | 渠道配置 |
| 5 | 多品类同时打折且有竞争关系 | `len(target_products) >= 3` 且品类可互替 | mid | 激励设计 |
| 6 | 目标 CVR 远高于基线无新激励 | `target_cvr / benchmark_cvr > 1.5` 且 `discount_value` 与历史相近 | high | 目标设定 |
| 7 | 短促销活动周期 | `(end_date - start_date) < 2天` 且非闪购 | mid | 时间安排 |
| 8 | 目标人群定义与目标品类错位 | `target_audience` 提到的品类 ≠ `target_products` | high | 人群定向 |
| 9 | 缺失基准 CVR | `benchmark_cvr` 为空 → 无法判断目标是否合理 | low | 目标设定 |
| 10 | target_products 疑似页面名非品类名 | `target_products` 中含"业务总览/首页/列表" | mid | 数据质量 |

> **规则 10 说明**：`--auto-meta` 从 `activity_product_name` 推断 `target_products` 时，该列有时存的是页面名（如"特价机票业务总览"）而非品类名（"机票"）。若触发规则 10，应在 `design_issues` 中标注并要求用户确认，避免后续品类匹配规则（Rule 11）判断全部错误。

### 第四步：写入 `state['campaign_profile']`

```json
{
  "name": "特价机票活动",
  "campaign_id": "1000344",
  "campaign_type": "大促",
  "config_summary": "2-3句活动背景摘要，含渠道、品类、激励要点，供后续6个维度引用",
  "design_issues": [
    {
      "issue": "target_products字段值为页面名「特价机票业务总览」而非品类名「机票」，已由用户确认修正为机票",
      "severity": "mid",
      "dimension": "数据质量",
      "suggestion": "在先知系统中检查 activity_product_name 的填报规范，统一使用品类名"
    }
  ],
  "target_vs_actual": {
    "cvr": "目标 15% vs 实际 11.99%（差距 -20%）"
  },
  "context_for_agents": "本次为特价机票大促活动（2026-05-05），单日单触达{实际渠道，来自target_channels}，同程APP主站投放。目标品类：机票。优惠形式未知。已知先天问题：(1)target_products填报为页面名，品类匹配规则需注意数据质量影响；(2)无目标CVR基准，无法进行目标偏差分析。后续诊断重点关注：内容匹配一致性（推送品类→用户兴趣匹配率）、营销无效触达比例。"
}
```

**`context_for_agents` 写作要求**：
- 必须包含：活动类型、核心渠道、目标品类、已知先天问题（1-2条）
- 必须包含：**后续诊断重点关注方向**（根据先天问题指向对应的规则类别）
- 长度 50-150 字，不超过 2 句，Agent 会把它拼接在各维度的 prompt 前缀里

> ⚠️ **渠道词汇约束（必须遵守）**：
> - `context_for_agents` 中的渠道描述必须引用 `target_channels`/`activity_channel_dist` 的实际值
> - `activity` 渠道 → 使用"活动推送/活动触达"，**严禁写"广告投放/广告进站/广告渠道"**
> - `push` 渠道 → 使用"Push 通知/Push 推送"
> - `popup` 渠道 → 使用"弹屏推送"
> - `sms` 渠道 → 使用"短信营销"
> - 只有 `target_channels` 中有 `ad`/`cpc`/`dsp`/`display` 时，才可以使用"广告"相关词汇

---

## 与后续诊断的联动

`design_issues` 触发时，在 Step 3b 生成 findings 时，对应维度规则应优先展开叙述：

| design_issue.dimension | 重点关注的诊断规则 | 联动说明 |
|---|---|---|
| 激励设计 | 转化效率 #19-21 | 如先天激励弱，#21（缺少临门一脚优惠）触发值得重点叙述 |
| 人群定向 | 内容匹配 #11、触达质量 #1 #5 | 品类错配（pre_mkt_product_browse_match=0）触发率是核心验证 |
| 渠道配置 | 触达质量 #2 #3、站内外 #13 #14、创单前营销 #34 #35 | 渠道滥用/多渠道冲突（#34 #35）与活动配置直接对应 |
| 时间安排 | 时机匹配 #6 #7 #44、关键打断 #15 #17 | period_mismatch_flag 触发率与先知场景实时/离线配置直接映射时段安排缺陷 |
| 目标设定 | 转化效率 #19 #20 #41 | CVR 偏差通过 diagnostic_rules_summary 的整体 cvr_gap 汇总验证 |
| 数据质量 | 内容匹配 #11、站内外 #13 | target_products 错误会导致品类匹配类规则全部误判，需在 data_caveats 标注 |

---

## 落地说明

- 本步**不依赖代码片段**，纯靠宿主 Agent 执行上述流程
- `campaign_profile` 为 null 时（跳过 Step 0 或纯 --auto-meta 运行），后续诊断仍可继续，但 `context_for_agents` 缺失
- 如使用 `--auto-meta` 且用户未补充任何字段，至少要对 `target_products` 的准确性做一次确认，否则品类匹配类规则（Rule 11）可能全部误判
