// Refuses to package a store build that could contain the QA seed from background.ts.
// Vite inlines any VITE_-prefixed variable into production bundles and loads .env files
// for `wxt zip` too, so a leftover VITE_QA_TOKEN would ship a real bearer token to every
// install. Run by the zip scripts in package.json before wxt zip.
import { readFileSync, existsSync } from 'node:fs';

const found = [];
if (process.env.VITE_QA_TOKEN) found.push('the shell environment');
for (const file of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  if (existsSync(file) && /^\s*VITE_QA_TOKEN\s*=\s*\S/m.test(readFileSync(file, 'utf8'))) {
    found.push(file);
  }
}

if (found.length > 0) {
  console.error(
    `Refusing to zip: VITE_QA_TOKEN is set in ${found.join(' and ')}. ` +
      'A store build must never contain the QA sign-in seed. Unset it and re-run.'
  );
  process.exit(1);
}
