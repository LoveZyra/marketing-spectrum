import { cn } from '../../../../lib/utils';
import { FAMILY_COLOR_CLASS, getFileFamily, getFileIconData } from '../../../file-tree/constants/fileIcons';

type Props = {
  /** 完整路径或文件名都行 —— 这里只取 basename 去查映射。 */
  path: string;
  className?: string;
};

/**
 * ej:产出列表的文件图标 —— 与**文件管理器完全同一套**映射。
 *
 * 之前两处产出(右侧面板、正文下的产出卡)一律画 `FileText`:一列一模一样的
 * 文档图标,`.py`、`.svg`、`.html` 混在一起,扫一眼分不出类型。文件树那边早就
 * 有成熟的一套(`getFileIconData` 按扩展名 / 特殊文件名解析,`getFileFamily`
 * 给七个语义族上色),没有理由在产出这边另起炉灶 —— 同一个文件在两个地方
 * 长得不一样,才是最容易让人怀疑"这是不是同一个东西"的细节。
 */
export default function FileTypeIcon({ path, className }: Props) {
  const filename = path.replace(/\\/g, '/').split('/').pop() || path;
  const { icon: Icon } = getFileIconData(filename);
  const family = getFileFamily(filename);
  return (
    <Icon
      className={cn('h-3.5 w-3.5 flex-none', FAMILY_COLOR_CLASS[family], className)}
      strokeWidth={2}
      aria-hidden
    />
  );
}
