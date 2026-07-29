import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ShapeIcon from './ShapeIcon.jsx';
import { SHAPE_CATEGORIES } from '../lib/shapes.js';

const EDGE_GAP = 6;
const DESKTOP_WIDTH = 470;


function releasePointerOwnership(target, pointerId) {
  if (!target || pointerId == null) return;
  try {
    if (typeof target.hasPointerCapture !== 'function' || target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture?.(pointerId);
    }
  } catch {
    // The palette may be unmounting while WebKit finishes implicit capture cleanup.
  }
}

function schedulePointerOwnershipRelease(target, pointerId) {
  releasePointerOwnership(target, pointerId);
  queueMicrotask(() => releasePointerOwnership(target, pointerId));
  window.requestAnimationFrame?.(() => releasePointerOwnership(target, pointerId));
  window.setTimeout(() => releasePointerOwnership(target, pointerId), 0);
}

function ShapeChoice({ id, label, onChoose }) {
  const controlRef = useRef(null);
  const activePointerIdRef = useRef(null);

  useEffect(() => () => {
    const pointerId = activePointerIdRef.current;
    if (pointerId != null) releasePointerOwnership(controlRef.current, pointerId);
  }, []);

  const handlePointerDown = (event) => {
    if (Number(event.button ?? 0) > 0) return;
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    activePointerIdRef.current = pointerId;
    schedulePointerOwnershipRelease(target, pointerId);

    // Release the palette item before onChoose closes the portal and removes this node.
    queueMicrotask(() => {
      releasePointerOwnership(target, pointerId);
      activePointerIdRef.current = null;
      onChoose(id);
    });
  };

  const finishPointer = (event) => {
    releasePointerOwnership(event.currentTarget, event.pointerId);
    if (String(activePointerIdRef.current) === String(event.pointerId)) {
      activePointerIdRef.current = null;
    }
  };

  return (
    <span
      ref={controlRef}
      role="button"
      tabIndex={0}
      className="shape-choice pointer-tool-control"
      title={label}
      aria-label={label}
      onPointerDown={handlePointerDown}
      onGotPointerCapture={(event) => releasePointerOwnership(event.currentTarget, event.pointerId)}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={finishPointer}
      onKeyDown={(event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        onChoose(id);
      }}
    >
      <ShapeIcon id={id} />
      <span>{label}</span>
    </span>
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
                <ShapeChoice
                  key={id}
                  id={id}
                  label={label}
                  onChoose={onChoose}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}
