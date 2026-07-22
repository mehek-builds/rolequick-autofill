import { MODE_DRAWS, resolvePreset, type OrbSize, type OrbState } from 'thinking-orbs';

// Content-script cards are plain DOM (no React), so this drives the same canvas
// drawer thinking-orbs' <ThinkingOrb> component uses internally, without the
// React wrapper. Cards are always rendered on a fixed white background
// regardless of the host page's theme, so `dark` is always false.
export function mountThinkingOrb(canvas: HTMLCanvasElement, state: OrbState, size: OrbSize = 20): () => void {
  const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const { mode, speed, opts } = resolvePreset(state, size);
  const draw = MODE_DRAWS[mode];
  const render = (t: number) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    draw(ctx, size, t, false, opts);
  };

  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    render(0.6);
    return () => {};
  }

  let raf = 0;
  let running = true;
  const tick = () => {
    render((performance.now() / 1000) * speed);
    if (running) raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    running = false;
    cancelAnimationFrame(raf);
  };
}
