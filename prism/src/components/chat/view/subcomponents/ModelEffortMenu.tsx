import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Loader2, SlidersHorizontal } from 'lucide-react';

import type { ProviderModelOption } from '../../../../types/app';
import ModelVendorIcon from '../../../llm-logo-provider/ModelVendorIcon';
import { AUTO_COMPACT_MARGIN, formatContextWindow, getModelVendor, detectModelVendor } from '../../../../../shared/modelVendors';
import { EFFORT_LABEL_KEYS, effectiveEffort, effortToStore, effortValues, nextEnabledIndex, splitModelMenu } from '../../utils/modelEffortMenu';
import { canFixWithKey, isModelAvailable } from '../../utils/modelAvailability';

/**
 * ho:**模型 + 档位的两级菜单**(Claude.ai 式,用户给的截图)。
 *
 *   ┌────────────────────────────┐   ┌─────────────────────────┐
 *   │ GLM 5.2                  ✓ │   │ 档位越高回答越周全……      │
 *   │ 一行说明                    │   │ 低                       │
 *   │────────────────────────────│   │ 中                       │
 *   │ 档位               高   ›  │──▶│ 高  [推荐]             ✓ │
 *   │────────────────────────────│   │ 最高 [⚠ 更慢、更费额度]   │
 *   │ 更多模型               ›   │   └─────────────────────────┘
 *   └────────────────────────────┘
 *
 * 上面一节 = 当前模型 + 目录里标了推荐的;「更多模型 ›」= 其余目录模型 + 别名(子代理用);
 * 「档位 ›」= 当前模型支持的档位,模型默认档标「推荐」,最高档提示更慢更费。没有档位的模型不出这一行。
 * 子菜单默认开在右边,右边放不下就开在左边;两边都放不下(手机 / 窄窗口)就**盖在主菜单上**,顶上一行「‹ 返回」。
 * Esc / 点外面关。键盘:↑↓ 在这一层里移动,→ 打开子菜单,← 回到上一层,Esc 一层层退出,关掉后焦点回到芯片。
 *
 * hq:**不能用的模型**(网关没有可用的 key / 网关停用)照样列出来,置灰、点不了(disabled + aria-disabled,↑↓ 跳过),
 * 第二行是服务端给的原因;填了 key 就能用的那种右边带一个「去填 key」(开 设置 → 模型网关)。
 * 本人的私有模型带「私有」小标、在上面一节;不在默认网关上的模型第二行带网关名。
 */

export type ModelEffortMenuProps = {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  options: ProviderModelOption[];
  currentValue: string | null;
  /** 存着的档位('default' = 跟模型默认)。 */
  effort: string;
  contextUsedTokens?: number | null;
  aliasTargets?: Record<string, string | null>;
  onSelectModel: (value: string) => Promise<unknown>;
  onSelectEffort: (value: string) => void;
  onOpenDetails?: () => void;
  /** hq:「去填 key」—— 开 设置 → 模型网关。不给就不出这个入口。 */
  onOpenKeySettings?: () => void;
  onClose: () => void;
};

const MAIN_WIDTH = 300;
const SUB_WIDTH = 300;
const GAP = 6;

type Submenu = 'effort' | 'more' | null;
/** 子菜单开在哪:右边 / 左边 / 两边都放不下就盖在主菜单上(复审:360px 宽的手机上原来只露出 2px)。 */
type SubPlacement = 'right' | 'left' | 'inline';

/** ↑↓ 走不到的项:真 disabled(切换中)或 aria-disabled(不能用的模型)。 */
const isInertItem = (element: HTMLElement): boolean =>
  element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
const FOCUSABLE_ITEM = ':not([disabled]):not([aria-disabled="true"])';

export default function ModelEffortMenu({
  open,
  anchorRef,
  options,
  currentValue,
  effort,
  contextUsedTokens,
  aliasTargets,
  onSelectModel,
  onSelectEffort,
  onOpenDetails,
  onOpenKeySettings,
  onClose,
}: ModelEffortMenuProps) {
  const { t } = useTranslation('chat');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; bottom: number; maxHeight: number; sub: SubPlacement } | null>(null);
  // 键盘打开子菜单时,渲染出来后把焦点放到它的第一项
  const focusSubOnOpenRef = useRef(false);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubmenu(null);
    setError(null);
  }, [open]);

  const updatePosition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(MAIN_WIDTH, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    // 子菜单右边放得下就开右边,否则左边;两边都不够就盖在主菜单上
    const fitsRight = left + width + GAP + SUB_WIDTH <= window.innerWidth - 8;
    const fitsLeft = left - GAP - SUB_WIDTH >= 8;
    setPosition({
      left,
      bottom: window.innerHeight - rect.top + 8,
      maxHeight: Math.max(200, rect.top - 16),
      sub: fitsRight ? 'right' : fitsLeft ? 'left' : 'inline',
    });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (submenu) {
        const parent = submenu;
        setSubmenu(null);
        menuRef.current?.querySelector<HTMLElement>(`[data-model-menu-row="${parent}"]`)?.focus();
      } else {
        onClose();
        anchorRef.current?.focus();
      }
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [open, onClose, updatePosition, anchorRef, submenu]);

  // 打开时焦点进菜单(第一项);键盘打开的子菜单,焦点进它的第一项
  useEffect(() => {
    if (!open || !position) return;
    const frame = requestAnimationFrame(() => {
      if (submenu && focusSubOnOpenRef.current) {
        focusSubOnOpenRef.current = false;
        menuRef.current?.querySelector<HTMLElement>(`[data-menu-level="sub"]${FOCUSABLE_ITEM}`)?.focus();
        return;
      }
      if (!submenu && !menuRef.current?.contains(document.activeElement)) {
        // hq:先落在第一个能选的模型行上(当前模型不能用时,不要一打开就落在它旁边的「去填 key」上)
        const root = menuRef.current;
        (root?.querySelector<HTMLElement>(`[data-menu-level="main"][data-model-row]${FOCUSABLE_ITEM}`)
          ?? root?.querySelector<HTMLElement>(`[data-menu-level="main"]${FOCUSABLE_ITEM}`))?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, position, submenu]);

  if (!open || !position) return null;

  const inline = position.sub === 'inline';
  const openSubmenu = (which: Exclude<Submenu, null>, viaKeyboard = false) => {
    focusSubOnOpenRef.current = viaKeyboard;
    setSubmenu(which);
  };
  const closeSubmenu = () => {
    const parent = submenu;
    setSubmenu(null);
    if (parent) requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>(`[data-model-menu-row="${parent}"]`)?.focus());
  };
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const level = submenu ? 'sub' : 'main';
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(`[data-menu-level="${level}"]`) ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      // hq:跳过禁用的(不能用的模型是 aria-disabled,切换中的行是 disabled)
      const next = nextEnabledIndex(items.map(isInertItem), index, event.key === 'ArrowDown' ? 1 : -1);
      if (next >= 0) items[next]?.focus();
    } else if (event.key === 'ArrowRight' && !submenu) {
      const row = (document.activeElement as HTMLElement | null)?.getAttribute('data-model-menu-row');
      if (row === 'effort' || row === 'more') {
        event.preventDefault();
        openSubmenu(row, true);
      }
    } else if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault();
      closeSubmenu();
    }
  };

  const current = options.find((option) => option.value === currentValue) ?? null;
  const { primary, more, aliases } = splitModelMenu(options, currentValue);
  const levels = effortValues(current);
  const activeEffort = effectiveEffort(current, effort);
  const effortLabel = (value: string) => (EFFORT_LABEL_KEYS[value] ? t(EFFORT_LABEL_KEYS[value]) : value);
  const used = typeof contextUsedTokens === 'number' && Number.isFinite(contextUsedTokens) && contextUsedTokens > 0 ? contextUsedTokens : null;

  const choose = async (value: string) => {
    if (changing) return;
    // hq:不能用的模型点不了(按钮已禁用;这里再挡一道,免得别的入口绕过来)
    if (!isModelAvailable(options.find((option) => option.value === value))) return;
    if (value === currentValue) {
      onClose();
      return;
    }
    setChanging(value);
    setError(null);
    try {
      await onSelectModel(value);
      onClose();
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : t('modelMenu.failed'));
    } finally {
      setChanging(null);
    }
  };

  const tooLargeFor = (option: ProviderModelOption): string | null => {
    const windowTokens = typeof option.contextWindow === 'number' ? option.contextWindow : null;
    if (!windowTokens || used === null || option.value === currentValue) return null;
    const line = windowTokens - AUTO_COMPACT_MARGIN;
    return used >= line ? t('modelMenu.tooLarge', { used: used.toLocaleString(), line: line.toLocaleString() }) : null;
  };

  const describe = (option: ProviderModelOption): string => {
    if (option.group === 'alias') {
      const target = aliasTargets?.[option.value];
      return target ? `→ ${target}` : t('modelMenu.aliasHint');
    }
    if (option.description) return option.description;
    const vendor = getModelVendor(option.vendor)?.label ?? getModelVendor(detectModelVendor(option.realModel || option.value))?.label ?? null;
    const windowLabel = formatContextWindow(typeof option.contextWindow === 'number' ? option.contextWindow : null);
    return [vendor, windowLabel ? t('modelMenu.window', { window: windowLabel }) : null].filter(Boolean).join(' · ') || option.value;
  };

  const rowBase = 'flex w-full items-center gap-2 rounded-lg px-3 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:cursor-default';
  // hq:不能用的行:不变色、禁用光标(与 rowBase 只差悬停与光标)
  const rowUnavailable = 'flex w-full items-center gap-2 rounded-lg px-3 text-left disabled:cursor-not-allowed';

  const unavailableText = (option: ProviderModelOption): string => option.unavailableReason || t('modelMenu.unavailable');
  const privateBadge = (
    <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[11px] leading-4 text-muted-foreground">{t('modelMenu.privateBadge')}</span>
  );
  /** 「去填 key」:先关菜单再开设置(设置是全屏弹窗,菜单留着会压在上面)。 */
  const keyLink = (option: ProviderModelOption, level: 'main' | 'sub') => (
    onOpenKeySettings && canFixWithKey(option) ? (
      <button
        type="button"
        role="menuitem"
        data-menu-level={level}
        data-model-key-link={option.value}
        onMouseEnter={() => { if (level === 'main' && !inline) setSubmenu(null); }}
        onClick={() => {
          onClose();
          onOpenKeySettings();
        }}
        className="mr-1 shrink-0 whitespace-nowrap rounded-md px-1.5 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        {t('modelMenu.fillKey')}
      </button>
    ) : null
  );

  // inline:盖在主菜单上(同宽、贴底),顶上有「‹ 返回」
  const subStyle = position.sub === 'left'
    ? { right: `calc(100% + ${GAP}px)`, width: SUB_WIDTH }
    : position.sub === 'right'
      ? { left: `calc(100% + ${GAP}px)`, width: SUB_WIDTH }
      // 盖满主菜单(minHeight 100%),主菜单那几行不会从上面露出来、也点不到
      : { left: 0, right: 0, minHeight: '100%' };
  const backRow = inline ? (
    <button
      type="button"
      role="menuitem"
      data-menu-level="sub"
      onClick={closeSubmenu}
      className="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden />
      {t('modelMenu.back')}
    </button>
  ) : null;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[100]"
      style={{ left: position.left, bottom: position.bottom, width: Math.min(MAIN_WIDTH, window.innerWidth - 16) }}
      data-model-menu="main"
    >
      <div className="prism-modal-shadow relative flex flex-col rounded-2xl border border-border bg-popover p-1.5" role="menu" aria-label={t('modelMenu.title')} onKeyDown={handleMenuKeyDown}>
        {/* 上面一节:当前 + 推荐 */}
        <div className="scrollbar-thin overflow-y-auto" style={{ maxHeight: Math.max(120, position.maxHeight - 140) }}>
          {primary.map((option) => {
            const isCurrent = option.value === currentValue;
            const unavailable = !isModelAvailable(option);
            const warn = unavailable ? null : tooLargeFor(option);
            const reason = unavailable ? unavailableText(option) : null;
            return (
              <div key={option.value} className="flex items-center">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  aria-disabled={unavailable || undefined}
                  data-model-row={option.value}
                  data-model-unavailable={unavailable ? 'true' : undefined}
                  data-menu-level="main"
                  onClick={() => void choose(option.value)}
                  onMouseEnter={() => { if (!inline) setSubmenu(null); }}
                  disabled={Boolean(changing) || unavailable}
                  title={reason ?? warn ?? undefined}
                  className={`${unavailable ? rowUnavailable : rowBase} min-w-0 flex-1 py-2`}
                >
                  {/* 厂商图标:别名按它配到的真实模型认,没配(官方 API)就是 Claude 自己的档位 */}
                  <span className={`grid h-5 w-5 shrink-0 place-items-center self-start pt-0.5 ${unavailable ? 'opacity-50 grayscale' : ''}`}>
                    {option.group === 'alias' ? (
                      <ModelVendorIcon
                        vendor={aliasTargets?.[option.value] ? null : 'claude'}
                        modelId={aliasTargets?.[option.value] || option.value}
                        label={option.value}
                        size={18}
                      />
                    ) : (
                      <ModelVendorIcon vendor={option.vendor} modelId={option.realModel || option.value} label={option.label || option.value} size={18} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={`truncate text-[14px] ${unavailable ? 'text-muted-foreground' : 'text-foreground'} ${option.group === 'alias' ? 'font-mono text-[13px]' : ''}`}>
                        {option.group === 'alias' ? option.value : (option.label || option.value)}
                      </span>
                      {option.private && privateBadge}
                    </span>
                    {reason ? (
                      // hq:不能用的原因(服务端的中文原句);窄屏两行放不下的部分在 title 里
                      <span className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-muted-foreground">{reason}</span>
                    ) : (
                      <span className="mt-0.5 flex min-w-0 items-center text-[12px] text-muted-foreground">
                        <span className="truncate">{describe(option)}</span>
                        {/* hq:不在默认网关上的模型带网关名 */}
                        {option.gatewayName && <span className="ml-1 max-w-[50%] shrink-0 truncate">· {option.gatewayName}</span>}
                      </span>
                    )}
                  </span>
                  {changing === option.value ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : warn ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-label={t('modelMenu.tooLargeShort')} />
                  ) : isCurrent ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" aria-label={t('modelMenu.current')} />
                  ) : null}
                </button>
                {keyLink(option, 'main')}
              </div>
            );
          })}
        </div>

        {levels.length > 0 && (
          <>
            <div className="mx-3 my-1 border-t border-border" />
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={submenu === 'effort'}
              data-model-menu-row="effort"
              data-menu-level="main"
              onClick={() => (submenu === 'effort' ? setSubmenu(null) : openSubmenu('effort'))}
              onMouseEnter={() => { if (!inline) setSubmenu('effort'); }}
              className={`${rowBase} py-2 ${submenu === 'effort' ? 'bg-accent' : ''}`}
            >
              <span className="flex-1 text-[14px] text-foreground">{t('modelMenu.effortRow')}</span>
              {activeEffort && <span className="text-[13px] text-muted-foreground">{effortLabel(activeEffort)}</span>}
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </>
        )}

        {(more.length > 0 || aliases.length > 0 || onOpenDetails) && (
          <>
            <div className="mx-3 my-1 border-t border-border" />
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={submenu === 'more'}
              data-model-menu-row="more"
              data-menu-level="main"
              onClick={() => (submenu === 'more' ? setSubmenu(null) : openSubmenu('more'))}
              onMouseEnter={() => { if (!inline) setSubmenu('more'); }}
              className={`${rowBase} py-2 ${submenu === 'more' ? 'bg-accent' : ''}`}
            >
              <span className="flex-1 text-[14px] text-foreground">{t('modelMenu.moreModels')}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </>
        )}

        {error && <p className="mx-3 mb-1 mt-1 text-[11.5px] leading-4 text-destructive" role="alert">{error}</p>}

        {/* 档位子菜单 */}
        {submenu === 'effort' && levels.length > 0 && (
          <div
            className="prism-modal-shadow scrollbar-thin absolute bottom-0 overflow-y-auto rounded-2xl border border-border bg-popover p-1.5"
            style={{ ...subStyle, maxHeight: position.maxHeight }}
            role="menu"
            data-model-menu="effort"
          >
            {backRow}
            <p className="px-3 pb-1.5 pt-1.5 text-[12px] leading-[18px] text-muted-foreground">{t('modelMenu.effortHint')}</p>
            {levels.map((value) => {
              const selected = value === activeEffort;
              const recommended = current?.effort?.default === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-effort={value}
                  data-menu-level="sub"
                  onClick={() => {
                    onSelectEffort(effortToStore(current, value));
                    onClose();
                  }}
                  className={`${rowBase} py-2`}
                >
                  <span className="text-[14px] text-foreground">{effortLabel(value)}</span>
                  {recommended && (
                    <span className="rounded bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{t('modelMenu.recommended')}</span>
                  )}
                  {value === 'max' && (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-px text-[11px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                      <AlertTriangle className="h-3 w-3" aria-hidden />
                      {t('modelMenu.maxWarning')}
                    </span>
                  )}
                  <span className="flex-1" />
                  {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        )}

        {/* 更多模型子菜单 */}
        {submenu === 'more' && (
          <div
            className="prism-modal-shadow absolute bottom-0 flex flex-col rounded-2xl border border-border bg-popover p-1.5"
            style={{ ...subStyle, maxHeight: position.maxHeight }}
            role="menu"
            data-model-menu="more"
          >
            {backRow}
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
              {more.map((option) => {
                const unavailable = !isModelAvailable(option);
                const warn = unavailable ? null : tooLargeFor(option);
                const reason = unavailable ? unavailableText(option) : null;
                const windowLabel = formatContextWindow(typeof option.contextWindow === 'number' ? option.contextWindow : null);
                return (
                  <div key={option.value} className="flex items-center">
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={false}
                      aria-disabled={unavailable || undefined}
                      data-model-row={option.value}
                      data-model-unavailable={unavailable ? 'true' : undefined}
                      data-menu-level="sub"
                      onClick={() => void choose(option.value)}
                      disabled={Boolean(changing) || unavailable}
                      title={[option.value, option.gatewayName, option.description, reason, warn].filter(Boolean).join('\n')}
                      className={`${unavailable ? rowUnavailable : rowBase} min-w-0 flex-1 py-2`}
                    >
                      <span className={`flex shrink-0 items-center ${unavailable ? 'self-start pt-0.5 opacity-50 grayscale' : ''}`}>
                        <ModelVendorIcon vendor={option.vendor} modelId={option.realModel || option.value} label={option.label || option.value} size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`truncate text-[14px] ${unavailable ? 'text-muted-foreground' : 'text-foreground'}`}>{option.label || option.value}</span>
                          {option.private && privateBadge}
                          {option.gatewayName && !unavailable && (
                            <span className="min-w-0 max-w-[45%] shrink truncate text-[11px] text-muted-foreground">{option.gatewayName}</span>
                          )}
                        </span>
                        {reason && <span className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-muted-foreground">{reason}</span>}
                      </span>
                      {changing === option.value ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : warn ? (
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      ) : windowLabel && !unavailable ? (
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{windowLabel}</span>
                      ) : null}
                    </button>
                    {keyLink(option, 'sub')}
                  </div>
                );
              })}
              {aliases.length > 0 && (
                <>
                  {more.length > 0 && <div className="mx-3 my-1 border-t border-border" />}
                  <p className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{t('modelMenu.aliases')}</p>
                  {aliases.map((option) => {
                    const target = aliasTargets?.[option.value];
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={false}
                        data-model-row={option.value}
                        data-menu-level="sub"
                        onClick={() => void choose(option.value)}
                        disabled={Boolean(changing)}
                        className={`${rowBase} py-1.5`}
                      >
                        <ModelVendorIcon vendor={target ? null : 'claude'} modelId={target || option.value} label={option.value} size={14} />
                        <span className="font-mono text-[12.5px] text-foreground">{option.value}</span>
                        {target && <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">→ {target}</span>}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
            {onOpenDetails && (
              <>
                <div className="mx-3 my-1 border-t border-border" />
                <button
                  type="button"
                  role="menuitem"
                  data-menu-level="sub"
                  onClick={() => {
                    onClose();
                    onOpenDetails();
                  }}
                  className={`${rowBase} py-1.5 text-[12.5px] text-muted-foreground`}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  {t('modelMenu.details')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
