"""marketing_audit_skill.snippets — 纯函数代码片段集合（V2 用户-活动粒度）。

新增（V2）：
- feature_loader.py    — FeatureLoader（字段注册表驱动的安全访问层）
- threshold_computer.py — CVR 驱动的自适应阈值计算
- diagnostic_engine.py  — 42 条诊断规则批量评估引擎

所有函数：
- 输入: pandas.DataFrame
- 输出: pandas.DataFrame 或 dict
- 无 LLM 依赖、无 Agent 框架依赖
"""
