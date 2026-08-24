import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  clearDrawingPreset,
  DRAWING_PRESET_COUNT,
  drawingPresetStorageKey,
  getDrawingPresets,
  normalizeDrawingPreset,
  saveDrawingPreset,
  sliderStepToWidth,
  STROKE_WIDTH_STEPS,
  widthToSliderStep,
} from '../lib/drawingPresets.js';

const EDGE_GAP = 8;
const MENU_WIDTH = 310;

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

function presetRgba(preset) {
  if (!preset) return 'transparent';
  const red = Number.parseInt(preset.color.slice(1, 3), 16);
  const green = Number.parseInt(preset.color.slice(3, 5), 16);
  const blue = Number.parseInt(preset.color.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${preset.opacity})`;
}

function presetsEqual(left, right) {
  if (!left || !right) return false;
  return left.color === right.color
    && Math.abs(left.opacity - right.opacity) < 0.001
    && left.width === right.width;
}

function PresetColor({ preset }) {
  return (
    <span className="drawing-preset-swatch" aria-hidden="true">
      {preset ? (
        <span className="drawing-preset-swatch-color" style={{ backgroundColor: presetRgba(preset) }} />
      ) : (
        <span className="drawing-preset-empty-mark">+</span>
      )}
    </span>
  );
}

export default function DrawingPresets({
  color,
  opacity,
  width,
  canApply,
  onApply,
}) {
  const [presets, setPresets] = useState(getDrawingPresets);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [draft, setDraft] = useState(null);
  const [placement, setPlacement] = useState(null);
  const anchorRef = useRef(null);
  const menuRef = useRef(null);
  const currentStyle = normalizeDrawingPreset({ color, opacity, width }) ?? {
    color: '#111827',
    opacity: 1,
    width: 3,
  };

  useEffect(() => {
    function handleStorage(event) {
      if (event.key === drawingPresetStorageKey()) setPresets(getDrawingPresets());
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    if (!editorOpen) return undefined;
    function closeOnOutside(event) {
      if (anchorRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      setEditorOpen(false);
    }
    window.addEventListener('pointerdown', closeOnOutside, true);
    return () => window.removeEventListener('pointerdown', closeOnOutside, true);
  }, [editorOpen]);

  useLayoutEffect(() => {
    if (!editorOpen) {
      setPlacement(null);
      return undefined;
    }
    const updatePlacement = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const viewport = window.visualViewport;
      const viewportWidth = Number(viewport?.width ?? window.innerWidth);
      const viewportHeight = Number(viewport?.height ?? window.innerHeight);
      const offsetLeft = Number(viewport?.offsetLeft ?? 0);
      const offsetTop = Number(viewport?.offsetTop ?? 0);
      const rect = anchor.getBoundingClientRect();
      const menuWidth = Math.max(260, Math.min(MENU_WIDTH, viewportWidth - EDGE_GAP * 2));
      const left = Math.min(
        Math.max(offsetLeft + EDGE_GAP, rect.left + offsetLeft),
        offsetLeft + viewportWidth - menuWidth - EDGE_GAP,
      );
      const top = rect.bottom + offsetTop + 7;
      setPlacement({
        left,
        top,
        width: menuWidth,
        maxHeight: Math.max(220, offsetTop + viewportHeight - top - EDGE_GAP),
      });
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
  }, [editorOpen]);

  function chooseEditorSlot(index) {
    setSelectedSlot(index);
    setDraft({ ...(presets[index] ?? currentStyle) });
  }

  function saveDraft() {
    if (selectedSlot == null || !draft) return;
    setPresets(saveDrawingPreset(selectedSlot, draft));
  }

  function clearSlot() {
    if (selectedSlot == null) return;
    setPresets(clearDrawingPreset(selectedSlot));
    setDraft({ ...currentStyle });
  }

  const toolbar = (
    <div className="drawing-presets-anchor" ref={anchorRef} aria-label="Сохранённые параметры рисования">
      <div className="drawing-preset-cells">
        {Array.from({ length: DRAWING_PRESET_COUNT }, (_, index) => {
          const preset = presets[index];
          const active = canApply && presetsEqual(preset, currentStyle);
          const title = preset
            ? `Пресет ${index + 1}: ${Math.round(preset.opacity * 100)}%, ${preset.width}px`
            : `Пресет ${index + 1} пуст — настройте через шестерёнку`;
          return (
            <StylusFastButton
              className={`drawing-preset-button${active ? ' active' : ''}${!preset ? ' empty' : ''}`}
              key={index}
              title={title}
              aria-label={title}
              aria-pressed={active}
              disabled={!preset || !canApply}
              onActivate={() => onApply?.(preset)}
            >
              <PresetColor preset={preset} />
            </StylusFastButton>
          );
        })}
      </div>
      <StylusFastButton
        className={`drawing-presets-gear${editorOpen ? ' active' : ''}`}
        title="Настроить три пресета рисования"
        aria-label="Настроить три пресета рисования"
        aria-expanded={editorOpen}
        onActivate={() => {
          setEditorOpen((open) => {
            if (!open) {
              setSelectedSlot(null);
              setDraft(null);
            }
            return !open;
          });
        }}
      >
        ⚙
      </StylusFastButton>
    </div>
  );

  if (!editorOpen || !placement || typeof document === 'undefined') return toolbar;

  return (
    <>
      {toolbar}
      {createPortal(
        <div
          className="drawing-presets-menu"
          ref={menuRef}
          role="dialog"
          aria-label="Настройка пресетов рисования"
          style={{
            left: placement.left,
            top: placement.top,
            width: placement.width,
            maxHeight: placement.maxHeight,
          }}
        >
          <div className="drawing-presets-menu-heading">
            <div>
              <strong>Мои параметры</strong>
              <span>Сохраняются на этом устройстве</span>
            </div>
            <StylusFastButton
              className="palette-close"
              aria-label="Закрыть"
              onActivate={() => setEditorOpen(false)}
            >
              ×
            </StylusFastButton>
          </div>

          <div className="drawing-presets-editor">
            <div className="drawing-presets-editor-slots" aria-label="Выберите ячейку">
              {presets.map((preset, index) => (
                <StylusFastButton
                  className={`drawing-preset-editor-button${selectedSlot === index ? ' active' : ''}`}
                  key={index}
                  aria-label={`Редактировать пресет ${index + 1}`}
                  aria-pressed={selectedSlot === index}
                  onActivate={() => chooseEditorSlot(index)}
                >
                  <PresetColor preset={preset} />
                  <span>{index + 1}</span>
                </StylusFastButton>
              ))}
            </div>

            {selectedSlot == null || !draft ? (
              <p className="drawing-presets-hint">Выберите один из трёх квадратиков.</p>
            ) : (
              <div className="drawing-preset-fields">
                <label className="drawing-preset-color-field">
                  <span>Цвет</span>
                  <input
                    type="color"
                    value={draft.color}
                    onChange={(event) => setDraft((value) => ({ ...value, color: event.target.value }))}
                  />
                </label>

                <label className="drawing-preset-slider">
                  <span>Прозрачность</span>
                  <input
                    type="range"
                    min="0.05"
                    max="1"
                    step="0.05"
                    value={draft.opacity}
                    onChange={(event) => setDraft((value) => ({
                      ...value,
                      opacity: Number(event.target.value),
                    }))}
                  />
                  <strong>{Math.round(draft.opacity * 100)}%</strong>
                </label>

                <label className="drawing-preset-slider">
                  <span>Толщина</span>
                  <input
                    type="range"
                    min="1"
                    max={STROKE_WIDTH_STEPS.length}
                    step="1"
                    value={widthToSliderStep(draft.width)}
                    onChange={(event) => setDraft((value) => ({
                      ...value,
                      width: sliderStepToWidth(event.target.value),
                    }))}
                  />
                  <strong>{draft.width}px</strong>
                </label>

                <div className="drawing-preset-editor-actions">
                  <button type="button" className="primary-button compact-button" onClick={saveDraft}>
                    Сохранить
                  </button>
                  <button
                    type="button"
                    className="danger-button compact-button"
                    onClick={clearSlot}
                    disabled={!presets[selectedSlot]}
                  >
                    Очистить
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
