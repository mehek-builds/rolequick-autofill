import { describe, expect, it } from 'vitest';
import { LOCAL_API_BASE, PRODUCTION_API_BASE, resolveApiBase } from './config';

describe('resolveApiBase', () => {
  it('defaults production builds to the deployed backend', () => {
    expect(resolveApiBase(undefined, false)).toBe(PRODUCTION_API_BASE);
    expect(resolveApiBase('   ', false)).toBe(PRODUCTION_API_BASE);
  });

  it('keeps local development local', () => {
    expect(resolveApiBase(undefined, true)).toBe(LOCAL_API_BASE);
  });

  it('honors an explicit QA backend and removes trailing slashes', () => {
    expect(resolveApiBase(' https://qa.example.com/// ', false)).toBe('https://qa.example.com');
  });
});
