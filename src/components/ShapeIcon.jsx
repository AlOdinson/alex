function Common({ children }) {
  return (
    <svg viewBox="0 0 64 48" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  );
}

export default function ShapeIcon({ id }) {
  switch (id) {
    case 'square': return <Common><rect x="13" y="5" width="38" height="38" /></Common>;
    case 'triangle': return <Common><path d="M32 5 55 42H9Z" /></Common>;
    case 'right-triangle': return <Common><path d="M12 6v36h42Z" /></Common>;
    case 'trapezoid': return <Common><path d="M15 6h35l5 36H10Z" /></Common>;
    case 'isosceles-trapezoid': return <Common><path d="M21 7h22l11 35H10Z" /></Common>;
    case 'parallelogram': return <Common><path d="M20 6h36L44 42H8Z" /></Common>;
    case 'diamond': return <Common><path d="m32 4 24 20-24 20L8 24Z" /></Common>;
    case 'pentagon': return <Common><path d="m32 4 24 17-9 23H17L8 21Z" /></Common>;
    case 'hexagon': return <Common><path d="m17 5 30 0 10 19-10 19H17L7 24Z" /></Common>;
    case 'octagon': return <Common><path d="m20 4 24 0 14 14v12L44 44H20L6 30V18Z" /></Common>;
    case 'star': return <Common><path d="m32 3 7 14 16 2-12 11 3 15-14-8-14 8 3-15L9 19l16-2Z" /></Common>;
    case 'circle': return <Common><circle cx="32" cy="24" r="19" /></Common>;
    case 'rounded-rect': return <Common><rect x="9" y="5" width="46" height="38" rx="9" /></Common>;
    case 'semicircle': return <Common><path d="M8 36a24 24 0 0 1 48 0Z" /></Common>;
    case 'quarter-circle': return <Common><path d="M10 42V6a36 36 0 0 1 36 36Z" /></Common>;
    case 'cube': return <Common><path d="M9 15h34v27H9Z M9 15l9-9h34v27l-9 9 M43 15l9-9" /></Common>;
    case 'wire-cube': return <Common><path d="M10 16L43 16L43 42L10 42Z M10 16L20 6L53 6L53 32L43 42 M43 16L53 6 M43 42L53 32" /><path strokeDasharray="3 3" d="M10 42L20 32M20 32L20 6M20 32L53 32" /></Common>;
    case 'cylinder': return <Common><ellipse cx="32" cy="9" rx="18" ry="5" /><path d="M14 9v30c0 3 8 5 18 5s18-2 18-5V9" /><path strokeDasharray="3 3" d="M14 39c0-3 8-5 18-5s18 2 18 5" /></Common>;
    case 'parallelepiped': return <Common><path d="M8 15h34l8 27H13Z M8 15l9-9h34l-9 9M51 6l-1 36" /></Common>;
    case 'pyramid': return <Common><path d="M10 35L28 43L54 35L36 27Z" /><path d="M32 4L10 35M32 4L28 43M32 4L54 35" /><path strokeDasharray="3 3" d="M32 4L36 27" /></Common>;
    case 'cone': return <Common><path d="M32 4 10 39c0 4 10 6 22 6s22-2 22-6Z" /><path strokeDasharray="3 3" d="M10 39c0-4 10-6 22-6s22 2 22 6" /></Common>;
    case 'sphere': return <Common><circle cx="32" cy="24" r="20" /><path d="M12 24c0 5 9 9 20 9s20-4 20-9" /><path strokeDasharray="3 3" d="M12 24c0-5 9-9 20-9s20 4 20 9" /><circle cx="32" cy="24" r="2.6" fill="currentColor" stroke="none" /></Common>;
    case 'tetrahedron': return <Common><path d="m32 4 24 38H8Z M32 4v28M8 42l24-10 24 10" /></Common>;
    case 'triangular-prism': return <Common><path d="M8 9v34l23-9ZM28 5v34l24-9ZM8 9l20-4M8 43l20-4M31 34l21-4" /></Common>;
    case 'octahedron': return <Common><path d="M32 3L8 24M32 3L32 32M32 3L56 24M32 45L8 24M32 45L32 32M32 45L56 24M8 24L32 32L56 24" /><path strokeDasharray="3 3" d="M8 24L32 16L56 24M32 3L32 16M32 45L32 16" /></Common>;
    case 'pyramid-frustum': return <Common><path d="M22 6h21l6 7H17ZM8 42h46l5-7H13ZM22 6 8 42M43 6l11 36M49 13l10 22" /></Common>;
    case 'cone-frustum': return <Common><ellipse cx="32" cy="8" rx="11" ry="4" /><path d="m21 8-12 31c0 4 10 6 23 6s23-2 23-6L43 8" /><path strokeDasharray="3 3" d="M9 39c0-4 10-6 23-6s23 2 23 6" /></Common>;
    default: return <Common><rect x="12" y="8" width="40" height="32" /></Common>;
  }
}
