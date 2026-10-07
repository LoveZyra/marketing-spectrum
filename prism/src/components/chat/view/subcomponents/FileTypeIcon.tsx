import { cn } from '../../../../lib/utils';
import { FAMILY_COLOR_CLASS, getFileFamily, getFileIconData } from '../../../file-tree/constants/fileIcons';

type Props = {
  /** 完整路径或文件名都行 —— 这里只取 basename 去查映射。 */
  path: string;
  className?: string;
};

/**
 * 产出列表(右侧面板、正文下的产出卡)的文件图标,与文件管理器同一套映射:
 * getFileIconData 按扩展名 / 特殊文件名选图标,getFileFamily 按语义族上色,
 * 同一个文件在两处长得一样。
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
