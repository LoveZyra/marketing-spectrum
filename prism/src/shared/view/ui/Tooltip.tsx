import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '../../../lib/utils';

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

type TooltipProps = {
  children: ReactNode;
  content?: ReactNode;
  position?: TooltipPosition;
  className?: string;
  /** 挂在触发元素外层容器上的类(默认 `relative inline-block`,想让它参与 flex 收缩时传 min-w-0 之类)。 */
  wrapperClassName?: string;
  delay?: number;
};

function getArrowClasses(position: TooltipPosition): string {
  switch (position) {
    case 'top':
      return 'top-full left-1/2 transform -translate-x-1/2 border-t-popover';
    case 'bottom':
      return 'bottom-full left-1/2 transform -translate-x-1/2 border-b-popover';
    case 'left':
      return 'left-full top-1/2 transform -translate-y-1/2 border-l-popover';
    case 'right':
      return 'right-full top-1/2 transform -translate-y-1/2 border-r-popover';
    default:
      return 'top-full left-1/2 transform -translate-x-1/2 border-t-popover';
  }
}

function Tooltip({
  children,
  content,
  position = 'top',
  className = '',
  wrapperClassName,
  delay = 350,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  // Store the timer id without forcing re-renders while hovering.
  const timeoutRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties | null>(null);

  const updateTooltipPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const spacing = 8;
    const style: React.CSSProperties = {
      position: 'fixed',
      zIndex: 9999,
    };

    // Calculate tooltip position based on the specified position prop.
    switch (position) {
      case 'bottom':
        style.left = rect.left + rect.width / 2;
        style.top = rect.bottom + spacing;
        style.transform = 'translateX(-50%)';
        break;
      case 'left':
        style.left = rect.left - spacing;
        style.top = rect.top + rect.height / 2;
        style.transform = 'translate(-100%, -50%)';
        break;
      case 'right':
        style.left = rect.right + spacing;
        style.top = rect.top + rect.height / 2;
        style.transform = 'translateY(-50%)';
        break;
      case 'top':
      default:
        style.left = rect.left + rect.width / 2;
        style.top = rect.top - spacing;
        style.transform = 'translate(-50%, -100%)';
        break;
    }

    setTooltipStyle(style);
  }, [position]);

  const clearTooltipTimer = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const handleMouseEnter = () => {
    clearTooltipTimer();
    timeoutRef.current = window.setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    clearTooltipTimer();
    setIsVisible(false);
  };

  const handleTouchStart = () => {
    clearTooltipTimer();
    longPressTriggeredRef.current = false;
    timeoutRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      setIsVisible(true);
    }, delay);
  };

  const handleTouchEnd = () => {
    clearTooltipTimer();
    if (longPressTriggeredRef.current) {
      return;
    }
    setIsVisible(false);
  };

  useEffect(() => {
    // Avoid delayed updates after unmount.
    return () => {
      clearTooltipTimer();
    };
  }, []);

  useEffect(() => {
    if (!isVisible || typeof document === 'undefined') {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) {
        return;
      }
      setIsVisible(false);
      longPressTriggeredRef.current = false;
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isVisible]);

  // 定位必须在**同一帧**完成 —— 用 useLayoutEffect 而不是 rAF。
  // 以前是先渲染在待定坐标、下一帧再挪过去,浮层于是从屏幕角上滑进来。
  useLayoutEffect(() => {
    if (!isVisible) {
      setTooltipStyle(null);
      return;
    }

    updateTooltipPosition();
    const handleViewportChange = () => updateTooltipPosition();

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isVisible, updateTooltipPosition]);

  if (!content) {
    return <>{children}</>;
  }

  return (
    <div
      ref={containerRef}
      className={cn('relative inline-block', wrapperClassName)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {children}
      {isVisible && typeof document !== 'undefined' && createPortal(
        <div
          ref={tooltipRef}
          style={tooltipStyle || { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }}
          className={cn(
            'pointer-events-none whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-card-foreground prism-modal-shadow',
            'tooltip-fade-in',
            className
          )}
        >
          {content}
          {/* Arrow */}
          <div className={cn('absolute w-0 h-0 border-4 border-transparent', getArrowClasses(position))} />
        </div>,
        document.body
      )}
    </div>
  );
}

export default Tooltip;
