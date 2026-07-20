export const PRODUCTION_API_BASE = 'https://student-outreach-backend.vercel.app';
export const LOCAL_API_BASE = 'http://localhost:3001';

export function resolveApiBase(configured: string | undefined, dev: boolean): string {
  const value = configured?.trim();
  if (value) return value.replace(/\/+$/, '');
  return dev ? LOCAL_API_BASE : PRODUCTION_API_BASE;
}

// A production package must work even when the release shell has no .env file. Before this
// fallback, `npm run build` silently embedded localhost and produced a store package whose every
// API call failed on users' machines. Development remains local by default; VITE_API_BASE still
// overrides both modes for QA builds and alternate backends.
export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE, import.meta.env.DEV);
