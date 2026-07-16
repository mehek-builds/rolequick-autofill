// Refuses to produce a production build that could contain the QA seed from background.ts.
// Vite inlines any VITE_-prefixed variable into production bundles and loads .env files
// for `wxt build`/`wxt zip` too, so a leftover VITE_QA_TOKEN would ship a real bearer token to
// every install. Run by the build AND zip scripts in package.json: gating zip alone left
// `npm run build` (documented in the README as the production build, and gated on by the PR
// template) free to emit a token-bearing .output/chrome-mv3 that could be zipped by hand.
// QA that genuinely wants the seed builds via `npm run build:qa`, which deliberately skips this.
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
    `Refusing to build: VITE_QA_TOKEN is set in ${found.join(' and ')}. ` +
      'A production build must never contain the QA sign-in seed. Unset it and re-run, ' +
      'or use `npm run build:qa` if you deliberately want the seeded QA build.'
  );
  process.exit(1);
}
