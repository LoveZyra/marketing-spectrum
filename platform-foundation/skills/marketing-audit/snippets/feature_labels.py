# -*- coding: utf-8 -*-
"""字段英文名 → 中文标签,全链路唯一的一份口径。

出处:原 report_renderer._humanize_feature 的内置映射表 + feature_registry.yaml
描述兜底,2026-08-14 提到本模块,供两处共用:
  · 报告渲染(report_renderer)—— 正文/表格里的字段叫法;
  · 圈人出参(crowd_translator.sql_to_zh)—— filter_zh 逐 token 直译时的字段翻译。
两处必须同名同译,所以只能有一份表。改标签只改这里。

查找顺序:FIELD_LABELS 显式映射 → registry 中文描述(剥尾注/切从句)→ 原名返回。
查不到返回原英文名 —— 未翻译可见可补,猜错的翻译贻害;绝不猜。
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

# 显式映射:报告与出参共用的字段中文名。
FIELD_LABELS: dict = {
    "pre_mkt_touch_cnt": "近1天营销触达次数", "pre_mainflow_event_cnt": "主流程行为次数",
    "pre_total_event_cnt": "总行为次数", "pre_active_span_min": "活跃时长（分钟）",
    "pre_events_per_hour": "行为密度", "activity_touch_cnt": "当日触达次数",
    "pre_coupon_collect_cnt": "领券数量", "pre_homepage_event_cnt": "首页行为次数",
    "pre_product_category_cnt": "浏览品类数", "pre_max_funnel_depth": "近1天最深漏斗深度",
    "pre_first_active_hour": "首次活跃小时", "pre_is_marketing_first": "营销作为首触点",
    "pre_is_marketing_last": "营销作为末触点", "pre_skip_detail_flag": "跳过详情页",
    "pre_popup_touch_cnt": "近1天弹屏触达次数", "pre_push_touch_cnt": "近1天Push触达次数",
    "pre_create_not_complete": "遗单用户", "pre_has_complete_order": "有历史成单",
    # 典型案例常用指标的简洁中文名（避免裸露英文字段名）
    "pre_funnel_pages_cnt": "主流程页面数", "pre_reached_payment": "到达支付页",
    "pre_create_order_cnt": "近1天创单次数", "pre_complete_order_cnt": "近1天成单次数",
    "pre_target_product_depth": "目标品类漏斗深度", "pre_target_product_funnel_depth": "目标品类漏斗深度",
    "pre_target_product_visit_cnt": "目标品类主流程浏览次数",
    "pre_mkt_direct_exit_cnt": "营销后直接退出次数", "pre_mkt_fatigue_cnt": "营销疲劳离开次数",
    "pre_popup_reject_cnt": "弹屏强拒绝次数", "pre_back_to_booking_cnt": "预订页回退次数",
    "pre_back_to_list_cnt": "详情返列表次数", "pre_over_mkt_flag": "近1天过度触达",
    "pre_funnel_regression_after_mkt": "营销后漏斗倒退次数",
    "pre_top_interest_product": "最深兴趣品类", "pre_mkt_product_browse_match": "活动品类匹配兴趣",
    "pre_browse_flight": "浏览过机票", "pre_browse_hotel": "浏览过酒店",
    "pre_browse_train": "浏览过火车票", "pre_browse_scenic": "浏览过景区",
    "pre_flight_visit_cnt": "机票主流程浏览次数", "pre_hotel_visit_cnt": "酒店主流程浏览次数",
    "pre_train_visit_cnt": "火车票主流程浏览次数",
    "pre_flight_depth": "机票漏斗深度", "pre_train_depth": "火车票漏斗深度",
    "pre_is_cross_category": "跨品类浏览",
    "pre_last_coupon_product": "最近领券品类", "pre_rp_target_product": "领过目标品类券",
    "pre_has_blackwhale": "领过黑鲸优惠",
    "activity_click_cnt": "当日点击次数", "is_converted": "是否转化", "is_paid": "是否成单",
    "ads_product_name": "站外广告品类", "first_insite_product_name": "站内承接品类",
    "ads_insite_match_flag": "站外站内品类一致", "has_ads_touch": "有站外广告触达",
    "has_insite_touch": "有站内承接",
    # 用户画像（V2.1）
    "age": "年龄", "gender": "性别", "member_level": "会员等级",
    "resident_city_level": "常住城市等级", "is_blackwhale_user": "黑鲸会员",
    "is_private_domain": "私域用户", "type_mem": "集团新老客", "type": "主题人群",
    "risk_type": "风险类型", "visit_days": "近90天访问天数", "timediff": "当天停留时长(秒)",
    "gmv": "近1年客单价(元)", "finance_revenue_after": "近1年消费营收(元)",
    "order_pc": "近1年消费频次", "360d_create_order_count": "近1年订单数",
    "order_cross": "跨品类交叉消费", "serialid_bonus": "促销订单占比",
    "last_create_order_time": "最近消费时间", "label001": "注册时间",
    # 先知场景（V2.1）
    "sceneid": "先知人群包编号", "scene_name": "先知节点名称",
    "is_today": "实时场景", "scene_has_offline_node": "含离线节点",
    # 规则库条件里出现、此前只靠 registry 兜底的字段(2026-08-14 显式补齐,
    # 标签覆盖门禁 test_feature_labels 守着:规则库用到的字段必须能翻出中文)
    "pre_last_mainflow_detail": "最近主流程明细",
    "pre_last_mainflow_to_touch_min": "最近主流程距触达分钟数",
    "pre_last_order_to_touch_min": "最近下单距触达分钟数",
    "pre_last_coupon_platform": "最近领券平台",
    "pre_primary_platform": "主活跃平台",
    "pre_is_dormant_user": "沉睡用户",
    # pre_browse_target_product 刻意不进显式表:registry 描述「近1天是否浏览过活动
    # 目标品类」带「是否」,报告的二值句式(_binary_phrase)靠它拼「未浏览过…」——
    # 显式表一旦盖掉它,句式退化成「无浏览过」(test_condition_zh 抓过)。
    "period_mismatch_flag": "投放时段不匹配",
    "activity_channel_std": "触达渠道",
    "activity_name": "活动名称",
    "coupon_min_valid_amount": "券最低使用门槛金额",
    "target_order_amount": "目标品类订单金额",
}


@lru_cache(maxsize=1)
def _registry_zh() -> dict:
    """feature_registry.yaml 的 {字段名: 中文描述},兜底用。缺 yaml/缺文件返回空。"""
    try:
        import yaml  # type: ignore
        path = Path(__file__).resolve().parent.parent / "feature_schema" / "feature_registry.yaml"
        reg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return {f["name"]: f.get("description", "")
                for f in reg.get("features", []) if f.get("name")}
    except Exception:  # noqa: BLE001
        return {}


def feature_label(name: str) -> str:
    """字段名 → 中文标签。查不到返回原名(可见的未翻译,绝不猜)。"""
    if not name:
        return name
    if name in FIELD_LABELS:
        return FIELD_LABELS[name]
    zh = _registry_zh().get(name)
    if zh:
        # 剥闭合尾括号说明 → 兜残缺半括号 → 切逗号后的解释从句(逗号前口径不动)。
        # 与原 report_renderer._humanize_feature 的清洗逻辑逐字一致。
        zh2 = re.sub(r"[（(][^（()）]*[)）]\s*$", "", zh).strip()
        zh2 = re.sub(r"[（(][^（()）]*$", "", zh2).strip()
        zh2 = re.split(r"[，,]", zh2, 1)[0].strip() or zh2
        return zh2 or zh
    return name
