interface BrandMarkProps {
  className?: string;
}

// The Litos mark: four bars tapering to a solid block, centred and sheared 6
// degrees. ALWAYS a black stack on a plain white ground. There is no reversed,
// tinted or accent-coloured variant, so this never sits on a coloured tile.
// Geometry is the same artwork the website generates in
// scripts/generate-brand-assets.mjs; keep the two in sync.
export default function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg className={className} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <rect width="100" height="100" fill="#ffffff" />
      <path
        fill="#000000"
        d="M32.81 8 L76.01 8 L75.17 16 L31.97 16 Z M27.53 24 L77.93 24 L77.09 32 L26.69 32 Z M22.25 40 L79.85 40 L79.01 48 L21.41 48 Z M16.97 56 L81.77 56 L80.93 64 L16.13 64 Z M11.69 72 L83.69 72 L81.59 92 L9.59 92 Z"
      />
    </svg>
  );
}
