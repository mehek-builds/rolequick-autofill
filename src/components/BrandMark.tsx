interface BrandMarkProps {
  className?: string;
}

// The Litos "dart" mark: a paper dart mid-flight, two triangles in brand blues.
// Transparent background so it can sit on any fill (brand-600 square, translucent circle, etc).
export default function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg className={className} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <path d="M55 10 L9 30 L25 37 Z" fill="#ffffff" />
      <path d="M55 10 L25 37 L29 54 Z" fill="#eef1fe" />
    </svg>
  );
}
