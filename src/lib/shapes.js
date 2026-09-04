import {
  Circle,
  Ellipse,
  Group,
  Line,
  Path,
  Polygon,
  Rect,
} from 'fabric';

export const SHAPE_CATEGORIES = [
  {
    id: '2d',
    label: '2D фигуры',
    shapes: [
      ['square', 'Квадрат'],
      ['triangle', 'Треугольник'],
      ['right-triangle', 'Прямоугольный треугольник'],
      ['parallelogram', 'Параллелограмм'],
      ['diamond', 'Ромб'],
      ['pentagon', 'Пятиугольник'],
      ['hexagon', 'Шестиугольник'],
      ['octagon', 'Восьмиугольник'],
      ['star', 'Звезда'],
      ['circle', 'Круг'],
      ['semicircle', 'Полукруг'],
    ],
  },
  {
    id: 'solids',
    label: '3D тела',
    shapes: [
      ['wire-cube', 'Каркасный куб'],
      ['cylinder', 'Цилиндр'],
      ['pyramid', 'Пирамида'],
      ['cone', 'Конус'],
      ['sphere', 'Сфера'],
      ['tetrahedron', 'Тетраэдр'],
      ['octahedron', 'Октаэдр'],
    ],
  },
];

export const HORIZONTALLY_MIRRORED_SOLID_IDS = new Set([
  'wire-cube',
  'pyramid',
  'tetrahedron',
  'octahedron',
]);

export function solidDragFlipX(shapeId, dragDx) {
  if (!HORIZONTALLY_MIRRORED_SOLID_IDS.has(shapeId)) return false;
  const numericDx = Number(dragDx);
  if (!Number.isFinite(numericDx) || numericDx === 0) return false;
  if (shapeId === 'wire-cube' || shapeId === 'pyramid') return numericDx > 0;
  return numericDx < 0;
}

function enableHorizontalDragMirror(object, shapeId) {
  if (!object || !HORIZONTALLY_MIRRORED_SOLID_IDS.has(shapeId)) return object;

  const originalSet = object.set;
  let creationAnchorLeft = null;
  let creationDraftActive = false;

  Object.defineProperty(object, 'set', {
    configurable: true,
    writable: true,
    value(key, value) {
      if (key && typeof key === 'object' && !Array.isArray(key)) {
        const attributes = { ...key };
        const hasLeft = Object.prototype.hasOwnProperty.call(attributes, 'left');
        const hasScaleX = Object.prototype.hasOwnProperty.call(attributes, 'scaleX');
        const left = Number(attributes.left);

        if (attributes.selectable === false
          && creationAnchorLeft == null
          && hasLeft
          && Number.isFinite(left)) {
          creationAnchorLeft = left;
          creationDraftActive = true;
        }

        if (creationDraftActive
          && creationAnchorLeft != null
          && hasLeft
          && hasScaleX
          && Number.isFinite(left)) {
          const dragDx = (left - creationAnchorLeft) * 2;
          const scaleMagnitude = Math.abs(Number(attributes.scaleX));
          if (Number.isFinite(scaleMagnitude)) attributes.scaleX = scaleMagnitude;
          attributes.flipX = solidDragFlipX(shapeId, dragDx);
        }

        const result = originalSet.call(this, attributes);
        if (attributes.selectable === true) {
          creationDraftActive = false;
          creationAnchorLeft = null;
        }
        return result;
      }

      return originalSet.call(this, key, value);
    },
  });

  return object;
}

function baseStyle({ stroke, strokeWidth }) {
  return {
    stroke,
    strokeWidth,
    strokeUniform: true,
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    fill: 'rgba(255,255,255,0.001)',
    originX: 'center',
    originY: 'center',
  };
}

function lineStyle({ stroke, strokeWidth }, dashed = false) {
  return {
    stroke,
    strokeWidth,
    strokeUniform: true,
    strokeLineCap: 'round',
    fill: '',
    selectable: false,
    evented: false,
    ...(dashed ? { strokeDashArray: [5, 5] } : {}),
  };
}

function regularPolygonPoints(sides, radius, rotation = -Math.PI / 2) {
  return Array.from({ length: sides }, (_, index) => {
    const angle = rotation + (index * Math.PI * 2) / sides;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
}

function starPoints(outerRadius, innerRadius, points = 5) {
  return Array.from({ length: points * 2 }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI) / points;
    const radius = index % 2 === 0 ? outerRadius : innerRadius;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
}

function group(children) {
  return new Group(children, {
    originX: 'center',
    originY: 'center',
    subTargetCheck: false,
    interactive: false,
  });
}

function lineBetween(from, to, style) {
  return new Line([from[0], from[1], to[0], to[1]], style);
}

function cubeChildren(style, dashedHidden = false) {
  const solid = lineStyle(style);
  const hidden = lineStyle(style, true);
  const frontTopLeft = [-54, -30];
  const frontTopRight = [34, -30];
  const frontBottomRight = [34, 46];
  const frontBottomLeft = [-54, 46];
  const backTopLeft = [-34, -48];
  const backTopRight = [54, -48];
  const backBottomRight = [54, 28];
  const backBottomLeft = [-34, 28];
  const rearStyle = dashedHidden ? hidden : solid;

  return [
    lineBetween(frontTopLeft, frontTopRight, solid),
    lineBetween(frontTopRight, frontBottomRight, solid),
    lineBetween(frontBottomRight, frontBottomLeft, solid),
    lineBetween(frontBottomLeft, frontTopLeft, solid),
    lineBetween(frontTopLeft, backTopLeft, solid),
    lineBetween(frontTopRight, backTopRight, solid),
    lineBetween(frontBottomRight, backBottomRight, solid),
    lineBetween(backTopLeft, backTopRight, solid),
    lineBetween(backTopRight, backBottomRight, solid),
    lineBetween(frontBottomLeft, backBottomLeft, rearStyle),
    lineBetween(backBottomLeft, backBottomRight, rearStyle),
    lineBetween(backBottomLeft, backTopLeft, rearStyle),
  ];
}

export function createShape(shapeId, options) {
  const style = baseStyle(options);
  let object;

  switch (shapeId) {
    case 'square':
      object = new Rect({ width: 112, height: 112, ...style });
      break;
    case 'triangle':
      object = new Polygon([{ x: 0, y: -62 }, { x: 62, y: 54 }, { x: -62, y: 54 }], style);
      break;
    case 'right-triangle':
      object = new Polygon([{ x: -58, y: -58 }, { x: -58, y: 58 }, { x: 58, y: 58 }], style);
      break;
    case 'trapezoid':
      object = new Polygon([{ x: -52, y: -52 }, { x: 42, y: -52 }, { x: 58, y: 52 }, { x: -58, y: 52 }], style);
      break;
    case 'isosceles-trapezoid':
      object = new Polygon([{ x: -36, y: -50 }, { x: 36, y: -50 }, { x: 58, y: 50 }, { x: -58, y: 50 }], style);
      break;
    case 'parallelogram':
      object = new Polygon([{ x: -38, y: -52 }, { x: 58, y: -52 }, { x: 38, y: 52 }, { x: -58, y: 52 }], style);
      break;
    case 'diamond':
      object = new Polygon([{ x: 0, y: -58 }, { x: 58, y: 0 }, { x: 0, y: 58 }, { x: -58, y: 0 }], style);
      break;
    case 'pentagon':
      object = new Polygon(regularPolygonPoints(5, 61), style);
      break;
    case 'hexagon':
      object = new Polygon(regularPolygonPoints(6, 61), style);
      break;
    case 'octagon':
      object = new Polygon(regularPolygonPoints(8, 61), style);
      break;
    case 'star':
      object = new Polygon(starPoints(63, 29), style);
      break;
    case 'circle':
      object = new Circle({ radius: 58, ...style });
      break;
    case 'rounded-rect':
      object = new Rect({ width: 116, height: 104, rx: 20, ry: 20, ...style });
      break;
    case 'semicircle':
      object = new Path('M -60 34 A 60 60 0 0 1 60 34 L -60 34 Z', style);
      break;
    case 'quarter-circle':
      object = new Path('M -56 56 L -56 -56 A 112 112 0 0 1 56 56 Z', style);
      break;
    case 'cube':
      object = group(cubeChildren(options, false));
      break;
    case 'wire-cube':
      object = group(cubeChildren(options, true));
      break;
    case 'cylinder': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      object = group([
        new Ellipse({ left: 0, top: -42, rx: 48, ry: 14, ...baseStyle(options) }),
        new Line([-48, -42, -48, 44], solid),
        new Line([48, -42, 48, 44], solid),
        new Path('M -48 44 A 48 14 0 0 0 48 44', solid),
        new Path('M -48 44 A 48 14 0 0 1 48 44', hidden),
      ]);
      break;
    }
    case 'parallelepiped': {
      const solid = lineStyle(options);
      object = group([
        new Polygon([{ x: -55, y: -34 }, { x: 32, y: -34 }, { x: 48, y: 42 }, { x: -68, y: 42 }], baseStyle(options)),
        new Polygon([{ x: -36, y: -52 }, { x: 55, y: -52 }, { x: 32, y: -34 }, { x: -55, y: -34 }], baseStyle(options)),
        new Line([55, -52, 48, 42], solid),
        new Line([32, -34, 48, 42], solid),
      ]);
      break;
    }
    case 'pyramid': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      object = group([
        new Polygon([{ x: -60, y: 43 }, { x: 34, y: 43 }, { x: 58, y: 26 }, { x: -30, y: 26 }], baseStyle(options)),
        new Line([0, -62, -60, 43], solid),
        new Line([0, -62, 34, 43], solid),
        new Line([0, -62, 58, 26], solid),
        new Line([0, -62, -30, 26], hidden),
      ]);
      break;
    }
    case 'cone': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      object = group([
        new Line([0, -62, -52, 43], solid),
        new Line([0, -62, 52, 43], solid),
        new Path('M -52 43 A 52 15 0 0 0 52 43', solid),
        new Path('M -52 43 A 52 15 0 0 1 52 43', hidden),
      ]);
      break;
    }
    case 'sphere': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      const centerDotRadius = Number(options.strokeWidth) / 2;
      const centerDot = new Circle({
        radius: centerDotRadius,
        left: 0,
        top: 0,
        originX: 'center',
        originY: 'center',
        fill: options.stroke,
        stroke: options.stroke,
        strokeWidth: 0,
        selectable: false,
        evented: false,
      });
      object = group([
        new Circle({ radius: 58, ...baseStyle(options) }),
        new Path('M -56 5 A 56 20 0 0 0 56 5', solid),
        new Path('M -56 5 A 56 20 0 0 1 56 5', hidden),
        centerDot,
      ]);
      break;
    }
    case 'tetrahedron': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      object = group([
        new Polygon([{ x: 0, y: -62 }, { x: 58, y: 46 }, { x: -58, y: 46 }], baseStyle(options)),
        new Line([0, -62, 0, 21], solid),
        new Line([0, 21, 58, 46], hidden),
        new Line([0, 21, -58, 46], hidden),
      ]);
      break;
    }
    case 'triangular-prism': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      object = group([
        new Polygon([{ x: -58, y: -42 }, { x: -58, y: 46 }, { x: 4, y: 22 }], baseStyle(options)),
        new Polygon([{ x: -4, y: -58 }, { x: -4, y: 28 }, { x: 58, y: 5 }], baseStyle(options)),
        new Line([-58, -42, -4, -58], solid),
        new Line([-58, 46, -4, 28], solid),
        new Line([4, 22, 58, 5], hidden),
      ]);
      break;
    }
    case 'octahedron': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      const top = [2, -64];
      const bottom = [-2, 64];
      const left = [-58, -6];
      const right = [58, 6];
      const front = [16, 22];
      const back = [-16, -22];
      object = group([
        lineBetween(top, left, solid),
        lineBetween(top, front, solid),
        lineBetween(top, right, solid),
        lineBetween(bottom, left, solid),
        lineBetween(bottom, front, solid),
        lineBetween(bottom, right, solid),
        lineBetween(left, front, solid),
        lineBetween(front, right, solid),
        lineBetween(left, back, hidden),
        lineBetween(back, right, hidden),
        lineBetween(top, back, hidden),
        lineBetween(bottom, back, hidden),
      ]);
      break;
    }
    case 'pyramid-frustum': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      object = group([
        new Polygon([{ x: -24, y: -48 }, { x: 30, y: -48 }, { x: 42, y: -35 }, { x: -13, y: -35 }], baseStyle(options)),
        new Polygon([{ x: -58, y: 48 }, { x: 40, y: 48 }, { x: 62, y: 28 }, { x: -36, y: 28 }], baseStyle(options)),
        new Line([-24, -48, -58, 48], solid),
        new Line([30, -48, 40, 48], solid),
        new Line([42, -35, 62, 28], solid),
        new Line([-13, -35, -36, 28], hidden),
      ]);
      break;
    }
    case 'cone-frustum': {
      const solid = lineStyle(options);
      const hidden = lineStyle(options, true);
      object = group([
        new Ellipse({ left: 0, top: -42, rx: 31, ry: 10, ...baseStyle(options) }),
        new Line([-31, -42, -52, 44], solid),
        new Line([31, -42, 52, 44], solid),
        new Path('M -52 44 A 52 15 0 0 0 52 44', solid),
        new Path('M -52 44 A 52 15 0 0 1 52 44', hidden),
      ]);
      break;
    }
    default:
      return null;
  }

  object.set({
    objectKind: 'shape',
    selectable: true,
    evented: true,
    hasControls: true,
  });
  object.setCoords();
  return enableHorizontalDragMirror(object, shapeId);
}