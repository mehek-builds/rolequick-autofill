import { describe, expect, it } from 'vitest';
import { API_VERSION, EXTENSION_VERSION, PRODUCT_NAME, litosClientHeaders } from './product';

describe('Litos product contract', () => {
  it('pins the offline identity and API compatibility fallback', () => {
    expect(PRODUCT_NAME).toBe('Litos');
    expect(API_VERSION).toBe('1');
    expect(EXTENSION_VERSION).toBe('0.4.1');
    expect(litosClientHeaders()).toEqual({
      'X-Litos-Client': 'extension',
      'X-Litos-Version': '0.4.1',
    });
  });
});
