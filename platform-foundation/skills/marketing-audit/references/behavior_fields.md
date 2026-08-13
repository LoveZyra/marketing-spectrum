# 用户-活动维度营销诊断特征工程说明文档 V2

## 一、概览

| 项目 | 说明 |
|---|---|
| **数据源** | `tmp_da.public_marketing_detail_mapid_20260505_add`；用户画像补充：`app_da.public_marketing_detail_mapid_add`；先知场景：`tmp_da.public_marketing_all_scene` |
| **输出表** | `app_da.tmp_ctj_mktv2_feature_day_v2` |
| **输出粒度** | 用户-活动维度（一行 = 一个用户被一个活动触达的记录） |
| **主键** | `mapid + activity_name + activity_id + activity_channel` |
| **活动唯一性** | `majorname`（活动名）+ `id`（活动ID）+ `detailname`（推送方式）三者联合唯一 |
| **核心标签** | `is_converted`：触达当日、`product_name` 与活动完全匹配的创单，`is_paid`：触达当日、`product_name` 与活动完全匹配的成单 |
| **特征范围** | 最后一次营销触达时刻（含）及之前的全量行为；触达后行为一律丢弃 |
| **多次触达处理** | 同一活动对同一用户多次触达时，取最后一次触达时间作为特征截止点 |
| **平台** | 不限 `platname`（覆盖同程APP / 微信 / 艺龙APP） |
| **方言** | Spark SQL 3.x |
| **特征总数** | 约 240 个（含 V2.1 新增用户画像 20 + 先知场景 4） |

---

## 二、建表步骤

| 步骤 | 中间表 | 说明 |
|---|---|---|
| Step 0 | `tmp_ctj_mktv2_base` | 基础行为清洗层，统一时间格式、标准化品类/渠道/漏斗深度 |
| Step 1 | `tmp_ctj_mktv2_anchor` | 活动触达锚点，确定每个用户-活动的最后触达时间 |
| Step 1b | `tmp_ctj_mktv2_cross_channel` | 用户-日期跨渠道汇总，站内外衔接诊断特征（含时序约束） |
| Step 2 | `tmp_ctj_mktv2_label` | 核心标签计算 |
| Step 3 | `tmp_ctj_mktv2_pre_base` | 触达前行为基础表（含窗口函数，供 Step 4-9 复用） |
| Step 4 | `tmp_ctj_mktv2_funnel` | 触达前漏斗特征 |
| Step 5 | `tmp_ctj_mktv2_pre_mkt` | 触达前历史营销行为特征 |
| Step 6 | `tmp_ctj_mktv2_product_pref` | 触达前产品偏好特征 |
| Step 7 | `tmp_ctj_mktv2_coupon` | 触达前红包偏好特征 |
| Step 8 | `tmp_ctj_mktv2_act_agg` | 触达前平台/活跃度/首页/会员特征 |
| Step 9 | `tmp_ctj_mktv2_path` | 触达前路径首末触点及行为序列 |
| Step 10 | `tmp_ctj_mktv2_order_ctx` | 触达前历史订单特征 |
| Step 11 | `tmp_ctj_mktv2_final` | 最终宽表，汇总全部特征 |

---

## 三、特征维度总览

| 维度 | 特征数 | 核心目标 |
|---|:---:|---|
| 活动维度信息 | 9 | 描述活动本身的触达形式与时机 |
| 核心标签 | 4 | 是否在触达当日完成 product_name 匹配的转化 |
| 营销时机匹配 | 1 | 触达时段是否与用户历史活跃时段一致 |
| 触达前决策周期 | 4 | 用户行为节点到触达时刻的时间距离 |
| 触达前漏斗 | 15 | 用户历史购买意向深度与路径异常信号 |
| 触达前历史营销 | 26 | 用户对历史营销的响应规律、疲劳程度及各渠道触达频次 |
| 触达前产品偏好 | 26 | 用户对各品类的历史兴趣与活动品类匹配度 |
| 触达前红包偏好 | 14 | 价格敏感度与品类优惠偏好 |
| 触达前平台/活跃/首页/会员 | 30 | 平台习惯、行为密度、内容曝光、会员关注 |
| 触达前行为路径 | 43 | 各类别首末触点、行为序列 |
| 触达前历史订单 | 12 | 历史下单状态与目标品类成单经历 |
| 跨渠道衔接特征 | 9 | 站内外渠道时序衔接、品类一致性诊断（Step 1b） |
| 用户画像（V2.1 新增） | 20 | 活动无关的静态用户属性：人口属性、会员/私域标识、消费价值、活跃与风险标签 |
| 活动静态信息与先知场景（V2.1 新增） | 4 | 先知人群包编号、场景节点名、实时/离线属性（按 activity_id 关联） |

---

## 四、特征详细说明

### 0. 活动维度信息

| 特征名 | 含义 |
|---|---|
| `mapid` | 用户主ID |
| `deviceid` | 设备ID |
| `unionid` | 微信 Union ID |
| `activity_name` | 活动名称（majorname） |
| `activity_id` | 活动ID（id） |
| `activity_channel` | 推送方式原始值（detailname，如弹屏/Push/短信） |
| `activity_channel_std` | 推送方式标准化（popup / push / sms / ads / insite_msg / activity） |
| `activity_product_name` | 活动投放品类（用于转化标签匹配的 product_name） |
| `touch_date` | 触达日期 |
| `last_touch_time` | 最后一次触达时刻（特征截止点） |
| `first_touch_time` | 首次触达时刻 |
| `touch_hour` | 最后触达的小时（0-23） |
| `touch_period` | 最后触达时段（上午/下午/晚上/深夜） |
| `activity_touch_cnt` | 近1天触达该用户的次数（单日数据） |
| `activity_click_cnt` | 近1天触达中用户点击次数（action=点击） |
| `is_activity_clicked` | 近1天是否有任意点击（0/1） |
| `activity_over_touch_flag` | 近1天触达≥5次，疑似过度触达（0/1） |

---

### 1. 核心标签

| 特征名 | 含义 |
|---|---|
| `is_converted` | 近1天触达、product_name 匹配的创单（0/1） |
| `is_paid` | 近1天触达、product_name 匹配的成单（0/1，区分创单未付，目标变量） |
| `convert_product` | 转化的品类名称（NULL 表示未转化） |
| `convert_time` | 首次转化时刻（NULL 表示未转化） |

> **转化判定逻辑**：`modelname IN ('创单','成单')` AND `event_date = touch_date` AND `event_time >= last_touch_time` AND `product_name = activity_product_name`

---

### 2. 营销时机匹配

| 特征名 | 含义 |
|---|---|
| `period_mismatch_flag` | 触达时段（touch_period）与用户历史活跃主时段不一致（0/1），诊断投放时机是否合理 |

---

### 3. 触达前决策周期特征

衡量用户各关键行为节点到最后一次触达时刻的时间距离。

| 特征名 | 含义 |
|---|---|
| `pre_first_expose_to_touch_min` | 近1天触达前首条行为到最后触达时刻的时间差（分钟），反映用户活跃时长 |
| `pre_last_mainflow_to_touch_min` | 近1天最近一次主流程行为到最后触达时刻的时间差，意向活跃度指示 |
| `pre_last_mkt_to_touch_min` | 近1天上一次营销到本次触达的时间差，反映营销频率 |
| `pre_last_order_to_touch_min` | 近1天最近成单到本次触达的时间差（分钟） |

---

### 4. 触达前漏斗特征

衡量用户在触达之前到达过的历史购买漏斗最深阶段。

| 特征名 | 含义 |
|---|---|
| `pre_max_funnel_depth` | 近1天最深漏斗阶段（1=首页 2=列表 3=详情 4=填写 5=支付，跨品类） |
| `pre_target_product_funnel_depth` | 近1天活动目标品类的最深漏斗阶段（漏斗维度） |
| `pre_funnel_pages_cnt` | 近1天访问过的不同主流程页面数（去重） |
| `pre_mainflow_event_cnt` | 近1天主流程行为总次数 |
| `pre_reached_homepage` | 近1天是否曾到达项目首页（0/1） |
| `pre_reached_list` | 近1天是否曾到达列表页（0/1） |
| `pre_reached_detail` | 近1天是否曾到达详情页（0/1） |
| `pre_reached_booking` | 近1天是否曾到达填写页（0/1） |
| `pre_reached_payment` | 近1天是否曾到达支付页（0/1） |
| `pre_back_to_list_cnt` | 近1天从详情页返回列表页的次数（犹豫/比价信号） |
| `pre_back_to_booking_cnt` | 近1天从填写页返回详情页的次数 |
| `pre_skip_detail_flag` | 近1天是否有跳过详情页直接进入填写页（熟客快速购买信号，0/1） |
| `pre_total_touch_cnt` | 近1天触达前总行为次数（含全类型事件） |
| `pre_browse_target_product` | 近1天是否浏览过活动目标品类（0/1） |
| `pre_target_product_visit_cnt` | 近1天活动目标品类的访问次数 |

---

### 5. 触达前历史营销行为特征

衡量用户对历史上其他营销活动的响应规律与疲劳程度。

| 特征名 | 含义 |
|---|---|
| `pre_mkt_touch_cnt` | 近1天触达前营销总触达次数（含本活动中间触达） |
| `pre_mkt_channel_cnt` | 近1天触达前被几种不同营销渠道触达 |
| `pre_touched_popup/push/sms/ads/insite_msg/activity` | 各渠道是否有历史触达（0/1 标志） |
| `pre_popup_touch_cnt` | 近1天弹屏触达次数（用于"创单前弹屏过多"阈值判断） |
| `pre_push_touch_cnt` | 近1天Push 触达次数 |
| `pre_sms_touch_cnt` | 近1天短信触达次数 |
| `pre_ads_touch_cnt` | 近1天广告触达次数 |
| `pre_insite_msg_touch_cnt` | 近1天站内信触达次数 |
| `pre_activity_touch_cnt` | 近1天活动营销触达次数 |
| `pre_mkt_click_cnt` | 近1天营销点击总次数 |
| `pre_has_mkt_click` | 近1天是否有任意营销点击（0/1） |
| `pre_popup_click_cnt` | 近1天弹屏点击次数 |
| `pre_push_click_cnt` | 近1天Push点击次数 |
| `pre_popup_click_rate` | 近1天弹屏点击率（NULL=无弹屏触达） |
| `pre_push_click_rate` | 近1天Push点击率（NULL=无Push触达） |
| `pre_mkt_fatigue_cnt` | 近1天营销后5分钟内离开的次数（营销疲劳信号） |
| `pre_mkt_direct_exit_cnt` | 近1天营销后直接退出（5分钟内无行为）的次数 |
| `pre_popup_reject_cnt` | 近1天弹屏10秒内即离开的次数（强拒绝信号） |
| `pre_funnel_regression_after_mkt` | 近1天营销后漏斗倒退次数（营销干扰购买流程） |
| `pre_mkt_trigger_mainflow_cnt` | 近1天营销5分钟内触发主流程的次数（营销有效导流） |
| `pre_over_mkt_flag` | 近1天触达前营销≥5次（过度触达标记，0/1） |
| `pre_min_mkt_response_sec` | 历史最短营销响应时间（秒）|
| `pre_unique_activity_cnt` | 近1天触达前被触达的不同活动数 |
| `pre_mkt_touched_target_product` | 近1天是否有推过同一 product_name 的营销（0/1） |

---

### 6. 触达前产品偏好特征

衡量用户对各旅行品类的历史兴趣深度及与活动品类的匹配程度。

| 特征名 | 含义 |
|---|---|
| `pre_browse_hotel/flight/train/scenic/car/bus/intl` | 是否有各品类历史主流程浏览（0/1） |
| `pre_hotel/flight/train/scenic_depth` | 各品类历史最深漏斗阶段（1-5） |
| `pre_hotel/flight/train/scenic/car/bus_visit_cnt` | 各品类主流程访问次数 |
| `pre_product_category_cnt` | 近1天浏览过的不同品类数 |
| `pre_is_cross_category` | 近1天是否有跨品类浏览（0/1） |
| `pre_browse_target_product` | 近1天是否浏览过活动目标品类（0/1） |
| `pre_target_product_depth` | 近1天活动目标品类的最深漏斗阶段（产品偏好维度） |
| `pre_target_product_visit_cnt` | 近1天活动目标品类的访问次数 |
| `pre_top_interest_product` | 近1天浏览最深的品类（酒店/机票/火车票/景区/用车/汽车票/无浏览） |
| `pre_mkt_product_browse_match` | 近1天活动目标品类是否与用户兴趣最深品类一致（0/1） |
| `pre_has_search` | 近1天是否有搜索行为（0/1） |
| `pre_search_cnt` | 近1天搜索行为次数 |
| `pre_search_hotel/flight/train/scenic` | 是否搜索过各品类入口（0/1） |
| `pre_search_target_product` | 近1天是否搜索过活动目标品类（0/1） |

---

### 7. 触达前红包偏好特征

衡量用户的价格敏感度及对各品类优惠的历史偏好。

| 特征名 | 含义 |
|---|---|
| `pre_coupon_collect_cnt` | 近1天红包/优惠领取总次数 |
| `pre_has_coupon` | 近1天是否有领券行为（0/1） |
| `pre_unique_coupon_cnt` | 近1天领取的不同红包品类数 |
| `pre_has_blackwhale` | 近1天是否领取过黑鲸相关优惠（高价值会员信号，0/1） |
| `pre_rp_hotel/flight/train/scenic/car/bus/vacation` | 是否领取过各品类红包（0/1） |
| `pre_rp_payment` | 近1天是否领取过支付优惠券（0/1） |
| `pre_rp_blackwhale_card` | 近1天是否领取过黑鲸卡优惠（0/1） |
| `pre_rp_target_product` | 近1天是否领取过活动目标品类的红包（先领券再被触达，价格驱动信号，0/1） |
| `pre_unique_coupon_product_cnt` | 近1天领取的不同红包 product_name 数量 |

---

### 8. 触达前平台/活跃度/首页/会员特征

| 特征名 | 含义 |
|---|---|
| `pre_total_event_cnt` | 近1天触达前总行为次数 |
| `pre_first_event_time` | 近1天触达前首条行为时间 |
| `pre_last_event_time` | 近1天触达前末条行为时间 |
| `pre_active_span_min` | 近1天首末行为时间跨度（分钟） |
| `pre_first_active_hour` | 近1天首条行为的小时（0-23） |
| `pre_first_active_period` | 近1天首条行为时段（上午/下午/晚上/深夜） |
| `pre_user_active_period` | 近1天行为量最多的时段（用于时机匹配诊断） |
| `pre_model_diversity` | 近1天行为涉及的不同 modelname 数量 |
| `pre_unique_touchpoints` | 近1天不同行为组合数（营销/主流程/公共页面范围内） |
| `pre_app/wechat/yilong_event_cnt` | 各平台历史行为次数 |
| `pre_is_cross_platform` | 近1天是否跨平台使用（0/1） |
| `pre_primary_platform` | 近1天行为最多的平台（同程APP/微信/艺龙APP） |
| `pre_morning/afternoon/evening/night_cnt` | 各时段历史行为次数 |
| `pre_events_per_hour` | 近1天每小时平均行为密度 |
| `pre_homepage_event_cnt` | 近1天大首页行为次数 |
| `pre_homepage_module_cnt` | 近1天曝光过的不同首页模块数 |
| `pre_banner_exposed` | 近1天是否曝光过 Banner（0/1） |
| `pre_new_user_zone_exposed` | 近1天是否曝光过新人专区（新客信号，0/1） |
| `pre_big_promo_exposed` | 近1天是否曝光过大促/S级活动（0/1） |
| `pre_kongfu_area_exposed` | 近1天是否曝光过金刚区（0/1） |
| `pre_waterfall_exposed` | 近1天是否曝光过瀑布流（0/1） |
| `pre_tile_area_exposed` | 近1天是否曝光过瓷片区（0/1） |
| `pre_pending_pay_viewed` | 近1天是否查看过待支付卡片（遗单召回信号，0/1） |
| `pre_pending_trip_viewed` | 近1天是否查看过待出行卡片（老客复购信号，0/1） |
| `pre_ai_entry_exposed` | 近1天是否触发过顶部 AI 入口（0/1） |
| `pre_add_to_desktop_exposed` | 近1天是否曝光过加桌入口（0/1） |
| `pre_viewed_member_assets` | 近1天是否查看过会员资产/权益入口（0/1） |
| `pre_black_whale_interest` | 近1天是否有黑鲸相关行为（0/1） |
| `pre_checkin_triggered` | 近1天是否触发过签到（0/1） |
| `pre_activity_nav_viewed` | 近1天是否访问过活动导航（0/1） |
| `pre_highlight_activity_viewed` | 近1天是否访问过精彩活动（0/1） |
| `pre_is_dormant_user` | 近1天触达前是否完全无行为（沉默用户被唤醒，0/1） |

---

### 9. 触达前行为路径特征

#### 9a. 整体首末触点

| 特征名 | 含义 |
|---|---|
| `pre_first_touch_model/detail/platform/majorname` | 触达前第一个行为的四维信息 |
| `pre_last_touch_model/detail/platform/majorname` | 触达前最后一个行为的四维信息 |
| `pre_is_marketing_first` | 近1天触达前首个行为是否为营销（被动流量进入，0/1） |
| `pre_is_marketing_last` | 近1天触达前末个行为是否为营销（0/1） |

#### 9b. 历史营销首末触点

| 特征名 | 含义 |
|---|---|
| `pre_first_mkt_time/channel/activity_name/platform` | 触达前首次历史营销的时间/渠道/活动名/平台 |
| `pre_last_mkt_time/channel/activity_name/platform` | 触达前末次历史营销的时间/渠道/活动名/平台 |

#### 9c. 主流程首末触点

| 特征名 | 含义 |
|---|---|
| `pre_first_mainflow_time/detail/product/platform` | 触达前首次进入主流程的时间/页面/品类/平台 |
| `pre_last_mainflow_time/detail/product/platform` | 触达前末次主流程行为的时间/页面/品类/平台 |

#### 9d. 红包首末触点

| 特征名 | 含义 |
|---|---|
| `pre_first_coupon_time/product/platform` | 触达前首次领券的时间/品类/平台 |
| `pre_last_coupon_time/product/platform` | 触达前末次领券的时间/品类/平台 |

#### 9e. 搜索首末触点

| 特征名 | 含义 |
|---|---|
| `pre_first_search_time/detail/product/platform` | 触达前首次搜索行为的时间/入口/品类/平台 |
| `pre_last_search_time/detail/product/platform` | 触达前末次搜索行为的时间/入口/品类/平台 |
| `pre_search_match_target` | 近1天末次搜索品类是否与活动目标品类一致（0/1） |

#### 9f. 行为路径序列

| 特征名 | 含义 |
|---|---|
| `pre_path_model_seq` | 近1天按时间顺序拼接的 modelname 序列，如 `营销->公共页面->主流程` |
| `pre_path_detail_seq` | 近1天按时间顺序拼接的 detailname 序列 |
| `pre_path_major_seq` | 近1天按时间顺序拼接的 majorname 序列（全量事件） |
| `pre_path_product_seq` | 近1天主流程品类序列（标准化 product_category，仅主流程行） |

---

### 10. 触达前历史订单特征

| 特征名 | 含义 |
|---|---|
| `pre_create_order_cnt` | 近1天创单次数 |
| `pre_complete_order_cnt` | 近1天成单次数 |
| `pre_has_create_order` | 近1天是否有创单（0/1） |
| `pre_has_complete_order` | 近1天是否有成单（0/1） |
| `pre_complete_product_cnt` | 近1天成单涉及的品类数（去重） |
| `pre_has_target_product_order` | 近1天是否有活动目标品类的成单（0/1） |
| `pre_has_target_product_create` | 近1天是否有活动目标品类的创单（含遗单，0/1） |
| `pre_is_repurchase` | 近1天是否有多次成单（复购用户，0/1） |
| `pre_is_target_product_repurchase` | 近1天是否有活动目标品类的复购（0/1） |
| `pre_last_order_product` | 近1天最近一次成单的品类 |
| `pre_last_order_time` | 近1天最近一次成单时间 |
| `pre_create_not_complete` | 近1天是否有创单未成单（遗单用户，0/1） |
| `pre_last_order_to_touch_min` | 近1天最近成单到本次触达的时间差（分钟） |

---

### 11. 跨渠道衔接特征（Step 1b）

粒度为**用户-日期**（`mapid + touch_date`），从 `tmp_ctj_mktv2_anchor` 聚合后 JOIN 进每行，解决站内外衔接类诊断问题（#12 站内多渠道不一致 / #13 站内外项目不一致 / #14 站外无站内承接）。

**时序约束**：站内渠道的首次触达时间须 ≥ 站外广告首次触达时间，确保"先有广告进站，再有站内承接"的因果顺序。

| 特征名 | 含义 |
|---|---|
| `has_ads_touch` | 近1天是否有站外广告（ads）触达（0/1） |
| `ads_product_name` | 近1天站外广告推送的品类（activity_product_name） |
| `has_insite_touch` | 近1天广告触达之后，是否有任意站内渠道跟进（0/1） |
| `first_insite_product_name` | 近1天广告之后首个站内营销活动的品类 |
| `ads_no_insite_flag` | 近1天有站外广告但广告后无任何站内承接（0/1，诊断 #14） |
| `ads_insite_match_flag` | 近1天站外广告与站内首个营销品类是否一致（1=匹配 0=不匹配 NULL=不适用，诊断 #13） |
| `insite_multi_channel_match_flag` | 近1天站内多渠道推送品类是否一致（1=一致 0=不一致 NULL=站内不足2种渠道，诊断 #12） |
| `insite_channel_cnt` | 近1天站内营销渠道种数（辅助判断多渠道冲突程度） |
| `insite_product_cnt` | 近1天站内营销涉及的不同品类数 |

---

### 12. 用户画像特征（V2.1 新增）

粒度为 **mapid**（活动无关的静态用户属性），来源表 `app_da.public_marketing_detail_mapid_add`，按 `mapid` 关联进宽表。人口属性 + 会员/私域标识 + 近1年消费价值 + 活跃与风险标签。数值价值字段（年龄/客单价/消费频次/营收/停留时长/促销占比等）登记 `percentile` 阈值，便于后续按成单率切分高/低价值人群。

| 特征名 | 含义 |
|---|---|
| `intotime` | 数据快照/进入时间（与历史首单时间比较判定集团新老客） |
| `age` | 用户年龄（岁） |
| `gender` | 性别 |
| `member_level` | 会员等级（数值越大等级越高） |
| `resident_city_level` | 常住地城市等级（一线/新一线/二线…） |
| `type` | 主题人群（运营圈定的用户主题标签） |
| `label001` | 注册时间 |
| `is_blackwhale_user` | 是否黑鲸会员用户（高价值会员标识，0/1） |
| `is_private_domain` | 是否私域用户（0/1） |
| `type_mem` | 集团新老客（集团老客/集团新客，由 `intotime` 与历史首单时间比较得出） |
| `risk_type` | 风险用户类型（风控标签） |
| `visit_days` | 近90天访问天数（活跃度） |
| `timediff` | 当天停留时长（秒） |
| `gmv` | 近1年客单价（元，消费价值） |
| `finance_revenue_after` | 近1年消费营收（元） |
| `order_pc` | 近1年消费频次 |
| `360d_create_order_count` | 近1年消费订单数 |
| `order_cross` | 是否跨品类交叉消费（0/1） |
| `serialid_bonus` | 促销订单占比（近1年促销/带券订单比例，价格敏感度） |
| `last_create_order_time` | 最近一次消费时间（用于计算最近消费间隔） |

---

### 13. 活动静态信息与先知场景（V2.1 新增）

粒度为 **activity_id**（活动/场景元数据），来源表 `tmp_da.public_marketing_all_scene`，按 `activity_id` 关联。描述本次活动对应的先知人群包与场景节点的实时/离线属性。`activity_id` 已在「0. 活动维度信息」登记。

| 特征名 | 含义 |
|---|---|
| `sceneid` | 先知场景/人群包编号（scene id） |
| `scene_name` | 先知节点名称（场景名） |
| `is_today` | 是否实时场景（1=实时 0=离线） |
| `scene_has_offline_node` | 该活动是否存在离线节点（源自 scene 表 `type` 字段） |

> ⚠️ **同名消歧**：scene 表的 `type`（是否存在离线节点）与维度 12 的 `type`（主题人群）同名。JOIN 进宽表时须将 scene 侧 `type` 重命名为 `scene_has_offline_node`，否则会与用户主题人群列冲突。

---

## 五、关键设计说明

### 标签设计

```
is_converted = 1 的条件（同时满足）：
  1. 行为发生在 touch_date（触达当日）
  2. 行为时间 >= last_touch_time（触达时刻之后）
  3. modelname IN ('创单', '成单')
  4. product_name = activity_product_name（品类完全匹配）
```

### 特征时间窗口

```
行为纳入特征的条件：
  event_time <= last_touch_time（含触达时刻本身）
  modelname NOT IN ('创单', '成单')（订单行为单独处理）
```

### 活动唯一性

```
同一活动 = majorname + id + detailname 三者联合唯一
同一用户被同一活动多次触达时：
  - 取最后一次触达时间（last_touch_time）作为特征截止点
  - activity_touch_cnt = 当日该活动对该用户的总触达次数
```

### 品类覆盖范围

主流程品类标准化覆盖：国际机票 / 机票 / 国际酒店 / 酒店 / 火车票 / 景区（含门票）/ 用车（含租车）/ 汽车票 / 度假 / 邮轮

---

## 六、版本记录

| 版本 | 日期 | 更新内容 |
|---|---|---|
| V2 | 2026-06-04 | 全新设计，从用户-订单维度重构为用户-活动维度；增加 product_name 转化匹配标签；全部特征改为触达前范围；合并原 1/ 和 2/ 特征体系；补全全品类覆盖（用车/汽车票）；新增搜索路径首末、各类别首末触点、三维行为序列 |
| V2.1 | 2026-06-25 | 新增两大类特征：①用户画像（20 个，mapid 粒度静态属性——人口属性/会员/私域/消费价值/活跃/风险，来源 `app_da.public_marketing_detail_mapid_add`）；②活动静态信息与先知场景（4 个，activity_id 粒度——先知人群包编号/场景名/实时离线属性，来源 `tmp_da.public_marketing_all_scene`）。同步登记进 `feature_schema/feature_registry.yaml`（维度 12/13），数值价值字段配 percentile 阈值 |
