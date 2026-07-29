import { useEffect, useRef, useState } from 'react';
import ShapePalette from './ShapePalette.jsx';

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

function IconButton({ title, children, active = false, disabled = false, onClick, className = '' }) {
  const buttonRef = useRef(null);
  const actionRef = useRef(onClick);
  const suppressClickUntilRef = useRef(0);
  actionRef.current = onClick;

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return undefined;

    function handleStylusTouchStart(event) {
      if (disabled || !firstStylusTouch(event)) return;
      // On iPadOS a Pencil tap on a native control can keep the browser's stylus
      // recognizer busy after the visual click has completed. Claim the stylus touch
      // before the compatibility click is created and run the action immediately.
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      suppressClickUntilRef.current = performance.now() + 900;
      actionRef.current?.({ inputType: 'stylus-touch', nativeEvent: event });
      button.blur();
    }

    button.addEventListener('touchstart', handleStylusTouchStart, {
      passive: false,
      capture: true,
    });
    return () => button.removeEventListener('touchstart', handleStylusTouchStart, true);
  }, [disabled]);

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
}) {
  const [shapesOpen, setShapesOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const shapeAnchorRef = useRef(null);
  const fileInputRef = useRef(null);
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

          <IconButton
            title="Добавить картинку"
            disabled={!canEdit}
            onClick={() => fileInputRef.current?.click()}
          >
            ▧
          </IconButton>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length) onAddImages(files);
              event.target.value = '';
            }}
          />
        </div>

        <div className="tool-group compact" aria-label="Отмена и возврат">
          <IconButton title="Отменить — Ctrl/Command + Z" disabled={!canEdit || !canUndo} onClick={onUndo}>↶</IconButton>
          <IconButton title="Вернуть — Ctrl/Command + Shift + Z" disabled={!canEdit || !canRedo} onClick={onRedo}>↷</IconButton>
        </div>

        <div className="toolbar-spacer" />

        <div className="tool-group compact zoom-group">
          <IconButton title="Уменьшить" onClick={onZoomOut}>−</IconButton>
          <button type="button" className="zoom-value" onClick={onResetZoom} title="Вернуть 100%">
            {Math.round(zoom * 100)}%
          </button>
          <IconButton title="Увеличить" onClick={onZoomIn}>+</IconButton>
        </div>

        {isOwner && (
          <div className="tool-group compact navigation-actions" aria-label="Навигация участников">
            <button
              type="button"
              className="navigation-text-button"
              title="Мгновенно переместить всех учеников к текущему месту на вашей доске"
              onClick={onBringStudents}
            >
              Ко мне
            </button>
          </div>
        )}

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

            {['pencil', 'line'].includes(tool) && (
              <IconButton
                title="Пипетка — скопировать параметры объекта или цвет пикселя картинки"
                active={eyedropperActive}
                disabled={!canEdit}
                onClick={onToggleEyedropper}
                className="eyedropper-button"
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
                  max="24"
                  step="1"
                  value={width}
                  disabled={!canEdit}
                  onChange={(event) => setWidth(Number(event.target.value))}
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
                className={eraserMode === 'partial' ? 'selected' : ''}
                disabled={!canEdit}
                onClick={() => setEraserMode('partial')}
              >
                Область
              </button>
              <button
                type="button"
                className={eraserMode === 'object' ? 'selected' : ''}
                disabled={!canEdit}
                onClick={() => setEraserMode('object')}
              >
                Объект
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
                  max="24"
                  step="1"
                  value={selectedSupports.width ?? 1}
                  disabled={!canEdit}
                  onChange={(event) => onSelectionWidthChange?.(Number(event.target.value))}
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
          <IconButton title="Очистить доску" disabled={!canEdit} onClick={onClear} className="danger-icon">⌫</IconButton>
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
