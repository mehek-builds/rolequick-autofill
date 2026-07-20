import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const popupEntry = readFileSync(new URL('../entrypoints/popup/main.tsx', import.meta.url), 'utf8');
const globalStyles = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

describe('popup font packaging', () => {
  it('bundles only the Latin Geist variable font instead of every language subset', () => {
    expect(popupEntry).not.toContain("import '@fontsource-variable/geist'");
    expect(globalStyles).toContain(
      "url('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2')",
    );
    expect(globalStyles).not.toMatch(/geist-(?:cyrillic|latin-ext|vietnamese)-/);
    expect(globalStyles).toContain('font-display: swap');
    expect(globalStyles).toContain("font-family: 'Geist Variable', 'Geist', sans-serif");
  });
});
