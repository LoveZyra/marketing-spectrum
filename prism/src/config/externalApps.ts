import { LineChart, type LucideIcon } from 'lucide-react';

/**
 * 挂在 Prism 上的外部应用清单,是外部入口的唯一真源:组件从这里读,不写死路径;接新的外部应用只加一条。
 *
 * 入口渲染在首页起手卡里。起手卡的提示词行是"把提示词填进输入框",外部应用是"跳到另一个应用",
 * 所以外链要和提示词行看得出区别(主题色描边 + 外链图标)。左侧图标轨只放 Prism 自己的标签页,不放外部应用。
 *
 * 入口不随反代配置隐藏:`PRISM_RECSYS_TARGET` 没配时入口照常显示,由服务端接住 `/recsys` 回一页配置提示
 * ("在 .env 里加这一行")。入口凭空消失比一句提示更难懂,用户只会以为坏了,所以这份清单是静态的,不问服务端。
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
