import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ShapeIcon from './ShapeIcon.jsx';
import { SHAPE_CATEGORIES } from '../lib/shapes.js';

const EDGE_GAP = 6;
const DESKTOP_WIDTH = 470;

export default function ShapePalette({ onChoose, onClose, anchorRef }) {
  const [placement, setPlacement] = useState(null);
  const handledPointerChoiceRef = useRef(null);

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
      const width = Math.max(250, Math.min(DESKTOP_WIDTH, viewportWidth - EDGE_GAP * 2));
      const preferredLeft = rect.left + viewportOffsetLeft - 76;
      const left = Math.min(
        Math.max(viewportOffsetLeft + EDGE_GAP, preferredLeft),
        viewportOffsetLeft + viewportWidth - width - EDGE_GAP,
      );
      const top = rect.bottom + viewportOffsetTop + 8;
      const maxHeight = Math.max(180, viewportOffsetTop + viewportHeight - top - EDGE_GAP);
      setPlacement({ left, top, width, maxHeight });
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
      }}
    >
      <div className="shape-palette-heading">
        <strong>Фигуры</strong>
        <button type="button" className="palette-close" onClick={onClose} aria-label="Закрыть">×</button>
      </div>
      <div className="shape-palette-scroll">
        {SHAPE_CATEGORIES.map((category) => (
          <section className="shape-category" key={category.id}>
            <h3>{category.label}</h3>
            <div className="shape-grid">
              {category.shapes.map(([id, label]) => (
                <button
                  type="button"
                  className="shape-choice"
                  key={id}
                  title={label}
                  onPointerDown={(event) => {
                    if (!['pen', 'touch'].includes(String(event.pointerType))) return;
                    event.preventDefault();
                    handledPointerChoiceRef.current = id;
                    onChoose(id);
                  }}
                  onClick={() => {
                    if (handledPointerChoiceRef.current === id) {
                      handledPointerChoiceRef.current = null;
                      return;
                    }
                    onChoose(id);
                  }}
                >
                  <ShapeIcon id={id} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}
