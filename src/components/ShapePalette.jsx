import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ShapeIcon from './ShapeIcon.jsx';
import { SHAPE_CATEGORIES } from '../lib/shapes.js';

const EDGE_GAP = 6;
const DESKTOP_WIDTH = 470;

function firstStylusTouch(event) {
  return [...Array.from(event?.changedTouches ?? []), ...Array.from(event?.touches ?? [])]
    .find((touch) => String(touch?.touchType ?? '').toLowerCase() === 'stylus') ?? null;
}

function StylusFastButton({ onActivate, children, ...props }) {
  const buttonRef = useRef(null);
  const actionRef = useRef(onActivate);
  const suppressClickUntilRef = useRef(0);
  actionRef.current = onActivate;

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;
    function handleTouchStart(event) {
      if (props.disabled || !firstStylusTouch(event)) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      suppressClickUntilRef.current = performance.now() + 900;
      actionRef.current?.();
      button.blur();
    }
    button.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
    return () => button.removeEventListener('touchstart', handleTouchStart, true);
  }, [props.disabled]);

  function handleClick(event) {
    if (performance.now() < suppressClickUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onActivate?.();
  }

  return (
    <button ref={buttonRef} type="button" {...props} onClick={handleClick}>
      {children}
    </button>
  );
}

export default function ShapePalette({ onChoose, onClose, anchorRef }) {
  const [placement, setPlacement] = useState(null);

  useLayoutEffect(() => {
    const updatePlacement = () => {
      const anchor = anchorRef?.current;
      if (!anchor) return;
      const viewport = window.visualViewport;
      const viewportWidth = Number(viewport?.width ?? window.innerWidth);
      const viewportHeight = Number(viewport?.height ?? window.innerHeight);
      const viewportOffsetLeft = Number(viewport?.offsetLeft ?? 0);
      const viewportOffsetTop = Number(viewport?.offsetTop ?? 0);
      const rect = anchor.getBoundingClientRect();
      const compactTouchLayout = Number(navigator.maxTouchPoints ?? 0) > 0
        && (window.matchMedia?.('(pointer: coarse)')?.matches || viewportWidth <= 1180);
      const preferredWidth = compactTouchLayout ? 370 : DESKTOP_WIDTH;
      const minimumWidth = compactTouchLayout ? 230 : 250;
      const width = Math.max(minimumWidth, Math.min(preferredWidth, viewportWidth - EDGE_GAP * 2));
      const preferredLeft = rect.left + viewportOffsetLeft - 76;
      const left = Math.min(
        Math.max(viewportOffsetLeft + EDGE_GAP, preferredLeft),
        viewportOffsetLeft + viewportWidth - width - EDGE_GAP,
      );
      const anchorTop = rect.top + viewportOffsetTop;
      const anchorBottom = rect.bottom + viewportOffsetTop;
      const viewportTop = viewportOffsetTop;
      const viewportBottom = viewportOffsetTop + viewportHeight;
      const availableAbove = anchorTop - viewportTop - EDGE_GAP - 8;
      const availableBelow = viewportBottom - anchorBottom - EDGE_GAP - 8;
      const openAbove = availableAbove > availableBelow;
      const availableHeight = openAbove ? availableAbove : availableBelow;
      const maxHeight = Math.max(140, Math.min(690, availableHeight));
      const top = openAbove ? anchorTop - 8 : anchorBottom + 8;
      setPlacement({ left, top, width, maxHeight, openAbove });
    };

    updatePlacement();
    const viewport = window.visualViewport;
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('orientationchange', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    viewport?.addEventListener('resize', updatePlacement);
    viewport?.addEventListener('scroll', updatePlacement);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('orientationchange', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
      viewport?.removeEventListener('resize', updatePlacement);
      viewport?.removeEventListener('scroll', updatePlacement);
    };
  }, [anchorRef]);

  if (!placement || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="shape-palette"
      role="dialog"
      aria-label="Фигуры"
      style={{
        left: placement.left,
        top: placement.top,
        width: placement.width,
        maxHeight: placement.maxHeight,
        '--shape-palette-max-height': `${placement.maxHeight}px`,
        transform: placement.openAbove ? 'translateY(-100%)' : undefined,
        transformOrigin: placement.openAbove ? 'bottom left' : 'top left',
      }}
    >
      <div className="shape-palette-heading">
        <strong>Фигуры</strong>
        <StylusFastButton className="palette-close" onActivate={onClose} aria-label="Закрыть">×</StylusFastButton>
      </div>
      <div className="shape-palette-scroll">
        {SHAPE_CATEGORIES.map((category) => (
          <section className="shape-category" key={category.id}>
            <h3>{category.label}</h3>
            <div className="shape-grid">
              {category.shapes.map(([id, label]) => (
                <StylusFastButton
                  className="shape-choice"
                  key={id}
                  title={label}
                  onActivate={() => onChoose(id)}
                >
                  <ShapeIcon id={id} />
                  <span>{label}</span>
                </StylusFastButton>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}
