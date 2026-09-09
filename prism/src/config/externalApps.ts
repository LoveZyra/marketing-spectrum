import { LineChart, type LucideIcon } from 'lucide-react';

/**
 * 挂在 Prism 上的**外部应用**清单(ek)。
 *
 * ## 为什么要有这份清单
 *
 * 「算法效果查询」此前**写死**在起手卡文件里(`href: '/recsys'` 直接躺在组件中)。
 * ek 把它抽成这份清单,理由有两层:入口不该写死在某个组件里,以后接第二个外部
 * 应用也只用加一条。ek 同时把它从起手卡里搬进了首页独立的「工具」栏目 ——
 * 因为起手卡的行为是"把提示词填进输入框",这枚链接的行为是"跳到另一个应用",
 * 两种交互模型挤在同一个框里读不出区别。
 *
 * **ex 把首页整体还原回 ef 之前的两栏版式,链接跟着回到第四张起手卡里** ——
 * 但只还原了位置,没还原写死:这里仍是唯一的真源,组件从清单里读。
 * "一张卡里两种行为要看得出区别"这条也留住了 —— 它在卡里长着主题色描边和
 * 外链图标,和提示词行明显不同。
 *
 * ek 一度在左侧图标轨上也挂了一格,el 撤掉了 —— 那条轨只放 Prism 自己的标签页。
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
