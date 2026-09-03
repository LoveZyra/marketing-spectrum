import { LineChart, type LucideIcon } from 'lucide-react';

/**
 * 挂在 Prism 上的**外部应用**清单(ek)。
 *
 * ## 为什么要有这份清单
 *
 * 「算法效果查询」此前写死在起手卡文件里,挂在第四张卡(方案咨询)的右下角。
 * 问题不是"不够醒目",是**位置不对**:起手卡的行为是"把提示词填进输入框",
 * 这枚链接的行为是"跳到另一个应用" —— 同一个 60px 的框里两种交互模型,读不出
 * 区别;更要紧的是**它只在首页有**,一进会话就没了,而"查算法效果"恰恰是
 * 边聊边查的动作。
 *
 * 现在它在首页有自己的「工具」栏目。ek 一度在左侧图标轨上也挂了一格,
 * el 撤掉了 —— 那条轨只放 Prism 自己的标签页,轨位另有用途。清单留着:
 * 一是入口不该再写死在某个组件里,二是以后接第二个外部应用直接加一条。
 *
 * ## 入口不随反代配置隐藏
 *
 * 沿用 cy 轮的决定:`PRISM_RECSYS_TARGET` 没配时**入口照常在**,由服务端接住
 * `/recsys` 回一页人话("在 .env 里加这一行")。入口凭空消失比给一句提示更难懂 ——
 * 用户只会以为是坏了。所以这份清单是静态的,不问服务端。
 */
export interface ExternalApp {
  key: string;
  /** i18n 键;取不到时用 fallback(中文)。 */
  labelKey: string;
  labelFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
  icon: LucideIcon;
  /** 相对路径 —— 真实地址由服务端反代决定,前端不写死主机。 */
  href: string;
  /** 目前一律新标签页:边看点位边在对话里问,切窗口比切标签页顺手。 */
  newTab: boolean;
}

export const EXTERNAL_APPS: ExternalApp[] = [
  {
    key: 'recsys',
    labelKey: 'externalApps.recsys.label',
    labelFallback: '算法效果查询',
    descriptionKey: 'externalApps.recsys.description',
    descriptionFallback: '推荐点位效果与实验监控',
    icon: LineChart,
    href: '/recsys',
    newTab: true,
  },
];
