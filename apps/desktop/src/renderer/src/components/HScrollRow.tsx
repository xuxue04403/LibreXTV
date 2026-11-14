import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 单行横向滚动的板块容器。
 *
 * 首页四个板块（发现 / 按分类浏览 / 继续观看 / 我的收藏）原来都用 `.grid`：
 * `repeat(auto-fill, minmax(168px, 1fr))` 会自动换行，10 条内容铺成两行、
 * 第二行只挂一两张，页面被拉得很长且节奏断裂。这里改成一行到底，
 * 放不下的部分靠左右滑动看。
 *
 * 三种操作都要顾到，因为这个应用同时被鼠标和触控板用户使用：
 * - 触控板：原生横向滑动（`overflow-x: auto`）
 * - 鼠标滚轮：纵向滚轮直接转成横移（否则用户会以为「滚不动 = 没有更多」）
 * - 鼠标点击：左右两侧的箭头按钮，只在对应方向还有内容时出现
 */
interface HScrollRowProps {
  children: ReactNode;
  /**
   * 是否给每一格固定宽度。
   * 卡片要固定（否则 flex 会把它们压扁），胶囊按钮不能固定（宽度跟着文字走）。
   */
  fixedItemWidth?: boolean;
  className?: string;
}

export function HScrollRow({ children, fixedItemWidth = true, className }: HScrollRowProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const sync = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(max > 4 && el.scrollLeft < max - 4);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    sync();
    // 图片加载完 / 窗口缩放 / 数据换了一批，都要重新判断箭头要不要出现
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    const mutation = new MutationObserver(sync);
    mutation.observe(el, { childList: true });
    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, [sync]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // 横向手势（触控板左右滑）交给浏览器自己处理，只接管纵向滚轮
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (el.scrollWidth - el.clientWidth <= 0) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const nudge = (direction: 1 | -1): void => {
    const el = trackRef.current;
    if (!el) return;
    // 一次翻「差不多一屏」，但至少要有三张卡的宽度，短行也看得出移动
    el.scrollBy({ left: direction * Math.max(260, el.clientWidth * 0.82), behavior: 'smooth' });
  };

  return (
    <div className={`hscroll${className ? ` ${className}` : ''}`}>
      {canLeft ? (
        <button type="button" className="hscroll-nav left" onClick={() => nudge(-1)} aria-label="向左滚动">
          <span aria-hidden="true">‹</span>
        </button>
      ) : null}
      <div
        ref={trackRef}
        className={`hscroll-track${fixedItemWidth ? '' : ' auto'}`}
        onScroll={sync}
      >
        {children}
      </div>
      {canRight ? (
        <button type="button" className="hscroll-nav right" onClick={() => nudge(1)} aria-label="向右滚动">
          <span aria-hidden="true">›</span>
        </button>
      ) : null}
    </div>
  );
}
