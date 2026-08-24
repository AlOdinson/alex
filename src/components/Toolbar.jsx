import { useEffect, useRef, useState } from 'react';
import DrawingPresets from './DrawingPresets.jsx';
import ShapePalette from './ShapePalette.jsx';
import {
  sliderStepToWidth,
  STROKE_WIDTH_STEPS,
  widthToSliderStep,
} from '../lib/drawingPresets.js';

const TOOLS = [
  { id: 'select', label: 'Выделение', icon: '↖' },
  { id: 'pencil', label: 'Карандаш', icon: '✎' },
  { id: 'line', label: 'Прямая', icon: '╱' },
  { id: 'eraser', label: 'Ластик', icon: '⌫' },
  { id: 'text', label: 'Текст', icon: 'T' },
];


const FONTS = [
  ['Arial', 'Arial'],
  ['Helvetica', 'Helvetica'],
  ['Times New Roman', 'Times New Roman'],
  ['Georgia', 'Georgia'],
  ['Verdana', 'Verdana'],
];


function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v4h14v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ShareLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M10.2 13.8l3.6-3.6m-5.9 6.9-1 .9a3.5 3.5 0 0 1-5-5l3.2-3.2a3.5 3.5 0 0 1 5 0m3.8-2.9 1-.9a3.5 3.5 0 1 1 5 5l-3.2 3.2a3.5 3.5 0 0 1-5 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function firstStylusTouch(event) {
  const changed = Array.from(event?.changedTouches ?? []);
  const active = Array.from(event?.touches ?? []);
  return [...changed, ...active].find(
    (touch) => String(touch?.touchType ?? '').toLowerCase() === 'stylus',
  ) ?? null;
}

function IconButton({ title, children, active = false, disabled = false, onClick, className = '', stylusActionPhase = 'start' }) {
  const buttonRef = useRef(null);
  const actionRef = useRef(onClick);
  const suppressClickUntilRef = useRef(0);
  const pendingStylusTouchIdRef = useRef(null);
  actionRef.current = onClick;

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;

    function handleStylusTouchStart(event) {
      const stylus = firstStylusTouch(event);
      if (disabled || !stylus) return;
      // Tool switches need to happen on touchstart so the next Pencil contact can draw
      // immediately. Commands that mutate the board (Undo/Redo, delete, paste, etc.)
      // must wait until touchend; starting them while the Pencil is still pressed keeps
      // WebKit's stylus recognizer and the main thread competing for the same contact.
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      suppressClickUntilRef.current = performance.now() + 900;
      pendingStylusTouchIdRef.current = stylus.identifier ?? null;
      if (stylusActionPhase === 'start') {
        pendingStylusTouchIdRef.current = null;
        actionRef.current?.({ inputType: 'stylus-touch', nativeEvent: event });
        button.blur();
      }
    }

    function handleStylusTouchEnd(event) {
      if (stylusActionPhase !== 'end' || pendingStylusTouchIdRef.current == null) return;
      const changed = Array.from(event?.changedTouches ?? []);
      const matching = changed.find((touch) => (
        touch.identifier === pendingStylusTouchIdRef.current
      ));
      if (!matching) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      suppressClickUntilRef.current = performance.now() + 900;
      pendingStylusTouchIdRef.current = null;
      button.blur();
      // Execute after the physical contact ends, but in this same event task. Waiting for
      // requestAnimationFrame made Pencil commands depend on Safari producing another
      // frame; under canvas pressure repeated taps then prolonged the apparent freeze.
      actionRef.current?.({ inputType: 'stylus-touch-end', nativeEvent: event });
    }

    function handleStylusTouchCancel(event) {
      const changed = Array.from(event?.changedTouches ?? []);
      if (changed.some((touch) => touch.identifier === pendingStylusTouchIdRef.current)) {
        pendingStylusTouchIdRef.current = null;
      }
    }

    button.addEventListener('touchstart', handleStylusTouchStart, {
      passive: false,
      capture: true,
    });
    button.addEventListener('touchend', handleStylusTouchEnd, {
      passive: false,
      capture: true,
    });
    button.addEventListener('touchcancel', handleStylusTouchCancel, {
      passive: true,
      capture: true,
    });
    return () => {
      button.removeEventListener('touchstart', handleStylusTouchStart, true);
      button.removeEventListener('touchend', handleStylusTouchEnd, true);
      button.removeEventListener('touchcancel', handleStylusTouchCancel, true);
    };
  }, [disabled, stylusActionPhase]);

  function handleClick(event) {
    if (performance.now() < suppressClickUntilRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`tool-button ${active ? 'active' : ''} ${className}`.trim()}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={handleClick}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}


function NavigationActionButton({ title, children, active = false, disabled = false, onClick }) {
  const buttonRef = useRef(null);
  const actionRef = useRef(onClick);
  const suppressClickUntilRef = useRef(0);
  const pendingStylusTouchIdRef = useRef(null);
  actionRef.current = onClick;

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;

    function handleStylusTouchStart(event) {
      const stylus = firstStylusTouch(event);
      if (disabled || !stylus) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      suppressClickUntilRef.current = performance.now() + 900;
      pendingStylusTouchIdRef.current = stylus.identifier ?? null;
    }

    function handleStylusTouchEnd(event) {
      if (pendingStylusTouchIdRef.current == null) return;
      const matching = Array.from(event?.changedTouches ?? []).find(
        (touch) => touch.identifier === pendingStylusTouchIdRef.current,
      );
      if (!matching) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      suppressClickUntilRef.current = performance.now() + 900;
      pendingStylusTouchIdRef.current = null;
      button.blur();
      actionRef.current?.();
    }

    function handleStylusTouchCancel() {
      pendingStylusTouchIdRef.current = null;
    }

    button.addEventListener('touchstart', handleStylusTouchStart, { passive: false, capture: true });
    button.addEventListener('touchend', handleStylusTouchEnd, { passive: false, capture: true });
    button.addEventListener('touchcancel', handleStylusTouchCancel, { passive: true, capture: true });
    return () => {
      button.removeEventListener('touchstart', handleStylusTouchStart, true);
      button.removeEventListener('touchend', handleStylusTouchEnd, true);
      button.removeEventListener('touchcancel', handleStylusTouchCancel, true);
    };
  }, [disabled]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`navigation-text-button ${active ? 'active' : ''}`.trim()}
      title={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={(event) => {
        if (performance.now() < suppressClickUntilRef.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}

export default function Toolbar({
  canEdit,
  tool,
  setTool,
  color,
  setColor,
  opacity,
  setOpacity,
  width,
  setWidth,
  onApplyDrawingPreset,
  eraserMode,
  setEraserMode,
  eraserWidth,
  setEraserWidth,
  fontFamily,
  setFontFamily,
  fontSize,
  setFontSize,
  background,
  setBackground,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onCopy,
  onPaste,
  onDelete,
  onClear,
  onAddShape,
  onAddImages,
  selectedCount,
  onMoveForward,
  onMoveBackward,
  onRotateLeft,
  onRotateRight,
  onFlipHorizontal,
  onFlipVertical,
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onBringStudents,
  autopilot = false,
  onToggleAutopilot,
  onOpenGames,
  gameLibraryVisible = false,
  saveStatus,
  users,
  onShare,
  isOwner,
  selectionStyle,
  onSelectionColorChange,
  onSelectionOpacityChange,
  onSelectionWidthChange,
  eyedropperActive,
  onToggleEyedropper,
  onExportCurrentPng,
  onExportPng,
  onExportPdf,
  onCopyImage,
  onShareImage,
  pendingCount = 0,
  syncTone = 'saved',
  screenShare = null,
}) {
  const [shapesOpen, setShapesOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const shapeAnchorRef = useRef(null);
  const exportAnchorRef = useRef(null);

  const showDrawingSettings = ['pencil', 'line', 'shape', 'text'].includes(tool);
  const showWidth = ['pencil', 'line', 'shape'].includes(tool);
  const showTextSettings = tool === 'text';
  const showEraserSettings = tool === 'eraser';
  const selectedSupports = selectionStyle ?? { canColor: false, canOpacity: false, canWidth: false };
  const showSelectedStyleControls = selectedCount > 0
    && (selectedSupports.canColor || selectedSupports.canOpacity || selectedSupports.canWidth);

  useEffect(() => {
    if (!shapesOpen && !exportOpen) return undefined;
    function closeOnOutside(event) {
      const insideShapeButton = shapeAnchorRef.current?.contains(event.target);
      const insideShapeMenu = event.target?.closest?.('.shape-palette');
      if (!insideShapeButton && !insideShapeMenu) setShapesOpen(false);
      if (!exportAnchorRef.current?.contains(event.target)) setExportOpen(false);
    }
    window.addEventListener('pointerdown', closeOnOutside);
    return () => window.removeEventListener('pointerdown', closeOnOutside);
  }, [shapesOpen, exportOpen]);

  return (
    <header className="toolbar-shell">
      <div className="toolbar-primary-row">
        <a className="brand-button" href={import.meta.env.BASE_URL} aria-label="На главную">A</a>

        <div className="tool-group main-tools" aria-label="Инструменты">
          {TOOLS.map((item) => (
            <IconButton
              key={item.id}
              title={item.label}
              active={tool === item.id}
              disabled={!canEdit}
              onClick={() => {
                setShapesOpen(false);
                setTool(item.id);
              }}
            >
              {item.icon}
            </IconButton>
          ))}

          <div className="shape-anchor" ref={shapeAnchorRef}>
            <IconButton
              title="Фигуры"
              active={tool === 'shape' || shapesOpen}
              disabled={!canEdit}
              onClick={() => {
                setTool('shape');
                setShapesOpen((value) => !value);
              }}
            >
              ◇
            </IconButton>
            {shapesOpen && (
              <ShapePalette
                anchorRef={shapeAnchorRef}
                onClose={() => setShapesOpen(false)}
                onChoose={(shapeId) => {
                  onAddShape(shapeId);
                  setShapesOpen(false);
                }}
              />
            )}
          </div>

          <label
            className={`tool-button image-upload-button ${!canEdit ? 'disabled' : ''}`.trim()}
            title="Добавить картинку"
            aria-label="Добавить картинку"
          >
            <span aria-hidden="true">▧</span>
            <input
              className="image-file-input"
              type="file"
              accept="image/*,.heic,.heif"
              multiple
              disabled={!canEdit}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                if (files.length) onAddImages(files);
                event.target.value = '';
              }}
            />
          </label>
        </div>

        <div className="tool-group compact" aria-label="Отмена и возврат">
          <IconButton title="Отменить — Ctrl/Command + Z" disabled={!canEdit || !canUndo} onClick={onUndo} stylusActionPhase="end">↶</IconButton>
          <IconButton title="Вернуть — Ctrl/Command + Shift + Z" disabled={!canEdit || !canRedo} onClick={onRedo} stylusActionPhase="end">↷</IconButton>
        </div>

        <div className="toolbar-spacer" />

        <div className="tool-group compact zoom-group">
          <IconButton title="Уменьшить" onClick={onZoomOut}>−</IconButton>
          <button type="button" className="zoom-value" onClick={onResetZoom} title="Вернуть 100%">
            {Math.round(zoom * 100)}%
          </button>
          <IconButton title="Увеличить" onClick={onZoomIn}>+</IconButton>
        </div>

        <div className="tool-group compact navigation-actions" aria-label="Навигация участников">
          {isOwner ? (
            <NavigationActionButton
              title="Мгновенно переместить всех учеников к текущему месту на вашей доске"
              onClick={onBringStudents}
            >
              Ко мне
            </NavigationActionButton>
          ) : (
            <NavigationActionButton
              active={autopilot}
              title={autopilot
                ? 'Отключить плавное следование за областью доски учителя'
                : 'Плавно следовать за областью доски учителя'}
              onClick={onToggleAutopilot}
            >
              Автопилот
            </NavigationActionButton>
          )}
          {isOwner && screenShare && (
            <NavigationActionButton
              active={screenShare.isHosting}
              disabled={screenShare.buttonDisabled}
              title={screenShare.activeRemoteSession
                ? 'На этой доске уже идёт демонстрация экрана'
                : (screenShare.isHosting
                  ? 'Остановить демонстрацию экрана'
                  : 'Показать экран или вкладку участникам')}
              onClick={screenShare.toggle}
            >
              {screenShare.isHosting ? 'Стоп экран' : 'Экран'}
            </NavigationActionButton>
          )}
        </div>

        {gameLibraryVisible && (
          <button
            type="button"
            className="game-library-button"
            title="Открыть игротеку"
            onClick={onOpenGames}
          >
            <span aria-hidden="true">🎮</span>
            <span className="game-library-button-label">Игротека</span>
          </button>
        )}

        <div className="presence-summary" title={users.map((user) => user.name).join(', ')}>
          <span className="presence-dot" />
          {users.length || 1}
        </div>

        <div className="toolbar-end-actions" aria-label="Экспорт и доступ к доске">
          <div className="export-anchor" ref={exportAnchorRef}>
            <button
              type="button"
              className="secondary-button toolbar-export-button"
              title="Экспорт"
              aria-label="Экспорт"
              onClick={() => setExportOpen((value) => !value)}
            >
              <span className="export-wide">Экспорт</span>
              <span className="export-narrow" aria-hidden="true"><ExportIcon /></span>
            </button>
            {exportOpen && (
              <div className="export-menu">
                <button type="button" onClick={() => { setExportOpen(false); onExportCurrentPng?.(); }}>PNG текущей области</button>
                <button type="button" onClick={() => { setExportOpen(false); onExportPng?.(); }}>PNG всей доски</button>
                <button type="button" onClick={() => { setExportOpen(false); onExportPdf?.(); }}>PDF всей доски</button>
                <button type="button" onClick={() => { setExportOpen(false); onCopyImage?.(); }}>Скопировать изображение</button>
                <button type="button" onClick={() => { setExportOpen(false); onShareImage?.(); }}>Отправить итог урока</button>
              </div>
            )}
          </div>

          {isOwner && (
            <button type="button" className="share-button toolbar-share-button" title="Поделиться ссылкой на доску" aria-label="Поделиться ссылкой на доску" onClick={onShare}>
              <span className="share-wide">Поделиться</span>
              <span className="share-narrow" aria-hidden="true"><ShareLinkIcon /></span>
            </button>
          )}
        </div>
      </div>

      <div className="toolbar-secondary-row">
        <DrawingPresets
          color={color}
          opacity={opacity}
          width={width}
          canApply={canEdit && showDrawingSettings}
          onApply={onApplyDrawingPreset}
        />

        {showDrawingSettings && (
          <div className="tool-group drawing-controls">
            <label className="color-control" title="Цвет">
              <span className="sr-only">Цвет</span>
              <input
                type="color"
                value={color}
                disabled={!canEdit}
                onChange={(event) => setColor(event.target.value)}
              />
            </label>

            {['pencil', 'line', 'shape'].includes(tool) && (
              <IconButton
                title="Пипетка — скопировать параметры объекта или цвет пикселя картинки"
                active={eyedropperActive}
                disabled={!canEdit}
                onClick={onToggleEyedropper}
                className="eyedropper-button"
                stylusActionPhase="end"
              >
                ⌾
              </IconButton>
            )}

            <label className="compact-slider" title={`Прозрачность: ${Math.round(opacity * 100)}%`}>
              <span>Прозр.</span>
              <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                value={opacity}
                disabled={!canEdit}
                onChange={(event) => setOpacity(Number(event.target.value))}
              />
              <strong>{Math.round(opacity * 100)}%</strong>
            </label>

            {showWidth && (
              <label className="compact-slider" title={`Толщина: ${width}px`}>
                <span>Толщ.</span>
                <input
                  type="range"
                  min="1"
                  max={STROKE_WIDTH_STEPS.length}
                  step="1"
                  value={widthToSliderStep(width)}
                  disabled={!canEdit}
                  onChange={(event) => setWidth(sliderStepToWidth(event.target.value))}
                />
                <strong>{width}px</strong>
              </label>
            )}

            {showTextSettings && (
              <>
                <label className="mini-select" title="Шрифт">
                  <span className="sr-only">Шрифт</span>
                  <select value={fontFamily} onChange={(event) => setFontFamily(event.target.value)}>
                    {FONTS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                  </select>
                </label>
                <label className="compact-slider font-size-slider" title={`Размер текста: ${fontSize}px`}>
                  <span>Размер</span>
                  <input
                    type="range"
                    min="12"
                    max="96"
                    step="1"
                    value={fontSize}
                    onChange={(event) => setFontSize(Number(event.target.value))}
                  />
                  <strong>{fontSize}</strong>
                </label>
              </>
            )}
          </div>
        )}

        {showEraserSettings && (
          <div className="tool-group eraser-controls">
            <div className="segmented-control" aria-label="Режим ластика">
              <button
                type="button"
                className={eraserMode === 'object' ? 'selected' : ''}
                disabled={!canEdit}
                onClick={() => setEraserMode('object')}
              >
                Объект
              </button>
              <button
                type="button"
                className={eraserMode === 'partial' ? 'selected' : ''}
                disabled={!canEdit}
                onClick={() => setEraserMode('partial')}
              >
                Область
              </button>
            </div>
            {eraserMode === 'partial' && (
              <label className="compact-slider" title={`Размер ластика: ${eraserWidth}px`}>
                <span>Размер</span>
                <input
                  type="range"
                  min="6"
                  max="100"
                  step="2"
                  value={eraserWidth}
                  disabled={!canEdit}
                  onChange={(event) => setEraserWidth(Number(event.target.value))}
                />
                <strong>{eraserWidth}</strong>
              </label>
            )}
          </div>
        )}

        {showSelectedStyleControls && (
          <div className="tool-group drawing-controls selected-style-controls">
            <span className="selection-style-label">Выбрано:</span>
            {selectedSupports.canColor && (
              <label className="color-control" title="Цвет выбранного">
                <span className="sr-only">Цвет выбранного</span>
                <input
                  type="color"
                  value={selectedSupports.color || '#111827'}
                  disabled={!canEdit}
                  onChange={(event) => onSelectionColorChange?.(event.target.value)}
                />
              </label>
            )}

            {tool === 'select' && (
              <IconButton
                title="Пипетка — применить параметры образца ко всем выделенным объектам"
                active={eyedropperActive}
                disabled={!canEdit || selectedCount === 0}
                onClick={onToggleEyedropper}
                className="eyedropper-button"
                stylusActionPhase="end"
              >
                ⌾
              </IconButton>
            )}

            {selectedSupports.canOpacity && (
              <label className="compact-slider" title={`Прозрачность выбранного: ${Math.round((selectedSupports.opacity ?? 1) * 100)}%`}>
                <span>Прозр.</span>
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={selectedSupports.opacity ?? 1}
                  disabled={!canEdit}
                  onChange={(event) => onSelectionOpacityChange?.(Number(event.target.value))}
                />
                <strong>{Math.round((selectedSupports.opacity ?? 1) * 100)}%</strong>
              </label>
            )}

            {selectedSupports.canWidth && (
              <label className="compact-slider" title={`Толщина выбранного: ${selectedSupports.width ?? 1}px`}>
                <span>Толщ.</span>
                <input
                  type="range"
                  min="1"
                  max={STROKE_WIDTH_STEPS.length}
                  step="1"
                  value={widthToSliderStep(selectedSupports.width ?? 1)}
                  disabled={!canEdit}
                  onChange={(event) => onSelectionWidthChange?.(sliderStepToWidth(event.target.value))}
                />
                <strong>{selectedSupports.width ?? 1}px</strong>
              </label>
            )}
          </div>
        )}

        <div className="tool-group compact edit-actions" aria-label="Редактирование">
          <IconButton title="Копировать" disabled={!canEdit || selectedCount === 0} onClick={onCopy}>⧉</IconButton>
          <IconButton title="Вставить" disabled={!canEdit} onClick={onPaste}>▣</IconButton>
          <IconButton title="Удалить выбранное" disabled={!canEdit || selectedCount === 0} onClick={onDelete}>×</IconButton>
          {isOwner && (
            <IconButton title="Очистить доску" disabled={!canEdit} onClick={onClear} className="danger-icon">⌫</IconButton>
          )}
        </div>

        {selectedCount > 0 && (
          <div className="tool-group compact object-actions" aria-label="Положение и поворот">
            <IconButton title="Опустить ниже" disabled={!canEdit} onClick={onMoveBackward}>⇩</IconButton>
            <IconButton title="Поднять выше" disabled={!canEdit} onClick={onMoveForward}>⇧</IconButton>
            <IconButton title="Повернуть влево на 90°" disabled={!canEdit} onClick={onRotateLeft}>↶90</IconButton>
            <IconButton title="Повернуть вправо на 90°" disabled={!canEdit} onClick={onRotateRight}>↷90</IconButton>
            <IconButton title="Отразить по горизонтали" disabled={!canEdit} onClick={onFlipHorizontal}>⇆</IconButton>
            <IconButton title="Отразить по вертикали" disabled={!canEdit} onClick={onFlipVertical}>⇅</IconButton>
          </div>
        )}

        {isOwner && (
          <label className="background-control" title="Фон доски">
            <span>Фон</span>
            <select value={background} onChange={(event) => setBackground(event.target.value)}>
              <option value="grid">Клетки</option>
              <option value="dots">Точки</option>
              <option value="blank">Белый лист</option>
            </select>
          </label>
        )}

        <div className={`toolbar-status sync-${syncTone}`} title={saveStatus}>
          <span className="sync-status-dot" />
          <span>{canEdit ? 'Редактирование' : 'Просмотр'}</span>
          <span>•</span>
          <span>{saveStatus}</span>
          {pendingCount > 0 && <strong>{pendingCount} в очереди</strong>}
        </div>
      </div>
    </header>
  );
}
