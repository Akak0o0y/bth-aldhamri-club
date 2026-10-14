// Monochrome mark: a white diamond outline around a dark-blue core.
export function BrandMark({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="brand-mark">
      <rect x="0.5" y="0.5" width="39" height="39" rx="11" fill="#0a0f1c" stroke="rgb(255 255 255 / 0.12)" />
      <path d="M20 8 32 20 20 32 8 20Z" fill="none" stroke="#f4f6fb" strokeWidth="1.6" />
      <path d="M20 14 26 20 20 26 14 20Z" fill="#2a4db3" />
    </svg>
  );
}
