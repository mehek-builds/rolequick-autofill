export const PRODUCT_NAME = 'Litos';
export const API_VERSION = '1';
export const EXTENSION_VERSION = '0.4.9';

export function litosClientHeaders(): Record<string, string> {
  const version =
    typeof chrome !== 'undefined' && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : EXTENSION_VERSION;
  return {
    'X-Litos-Client': 'extension',
    'X-Litos-Version': version,
  };
}

export type ProductMeta = {
  product: {
    name: string;
    links: {
      website: string;
      install: string;
      privacy: string;
      supportEmail: string;
    };
  };
  api: {
    version: string;
    compatibility: {
      extension: { minimum: string };
      web: { minimum: string };
    };
  };
};
