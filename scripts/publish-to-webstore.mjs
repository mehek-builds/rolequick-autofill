#!/usr/bin/env node
/**
 * Upload and submit the extension to the Chrome Web Store.
 *
 *   CWS_CLIENT_ID=... CWS_CLIENT_SECRET=... CWS_REFRESH_TOKEN=... \
 *     node scripts/publish-to-webstore.mjs [--submit]
 *
 * Without --submit it only uploads the package as a draft, so the listing can
 * be eyeballed in the dashboard before anything goes to review.
 *
 * WHY THIS EXISTS: the dashboard cannot be automated. Chrome refuses all
 * extension scripting on chrome.google.com/webstore ("The extensions gallery
 * cannot be scripted"), so a browser agent can never click through it. The API
 * is the only programmatic path, and it needs the three env vars above.
 *
 * ONE-TIME SETUP (about ten minutes, and only Mehek can do it because every
 * step is behind a Google sign-in):
 *   1. console.cloud.google.com -> new project -> enable "Chrome Web Store API"
 *   2. APIs & Services -> OAuth consent screen -> External -> add yourself as a
 *      test user. Use the SAME Google account that owns the extension
 *      (maggimandal@gmail.com), not a different one.
 *   3. Credentials -> Create OAuth client ID -> type "Desktop app"
 *      -> note the client id and client secret
 *   4. Get a refresh token once:
 *        open https://accounts.google.com/o/oauth2/auth?response_type=code\
 *        &scope=https://www.googleapis.com/auth/chromewebstore\
 *        &client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&access_type=offline&prompt=consent
 *      approve, copy the ?code= out of the redirected URL, then:
 *        curl -s https://oauth2.googleapis.com/token \
 *          -d client_id=... -d client_secret=... -d code=... \
 *          -d grant_type=authorization_code -d redirect_uri=http://localhost
 *      the response contains refresh_token. Store all three in ~/.secrets.
 *
 * After that this script publishes every future release in one command.
 */
import { readFile } from 'node:fs/promises';

const ITEM_ID = 'bdbedbmkjpfioknfpmhookefabipjaad';
const { CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN } = process.env;
const SUBMIT = process.argv.includes('--submit');

if (!CWS_CLIENT_ID || !CWS_CLIENT_SECRET || !CWS_REFRESH_TOKEN) {
  console.error('Missing CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN.');
  console.error('See the setup block at the top of this file.');
  process.exit(1);
}

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const zipPath = new URL(`../.output/litos-extension-${pkg.version}-chrome.zip`, import.meta.url);
const zip = await readFile(zipPath);

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: CWS_CLIENT_ID,
    client_secret: CWS_CLIENT_SECRET,
    refresh_token: CWS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }),
});
const { access_token, error_description } = await tokenRes.json();
if (!access_token) throw new Error(`Token refresh failed: ${error_description ?? 'unknown'}`);

const auth = { Authorization: `Bearer ${access_token}`, 'x-goog-api-version': '2' };

process.stdout.write(`uploading ${pkg.version} (${(zip.length / 1024).toFixed(0)} kB)... `);
const up = await fetch(
  `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${ITEM_ID}`,
  { method: 'PUT', headers: auth, body: zip },
);
const upJson = await up.json();
if (upJson.uploadState !== 'SUCCESS') {
  console.error('\nupload failed:', JSON.stringify(upJson, null, 2));
  process.exit(1);
}
console.log('ok');

if (!SUBMIT) {
  console.log('Draft uploaded. Review the listing, then re-run with --submit.');
  process.exit(0);
}

process.stdout.write('submitting for review... ');
const pub = await fetch(
  `https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM_ID}/publish`,
  { method: 'POST', headers: { ...auth, 'Content-Length': '0' } },
);
console.log(JSON.stringify(await pub.json(), null, 2));

/* NOTE: screenshots and promo tiles are NOT settable through this API. It
   covers the package and the publish action only. The listing images in
   store-assets/ still have to be attached by hand in the dashboard, once. */
