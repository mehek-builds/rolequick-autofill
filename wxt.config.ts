import { defineConfig } from 'wxt';
import { EXTENSION_VERSION, PRODUCT_NAME } from './src/lib/product';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: ({ command }) => ({
    name: `${PRODUCT_NAME}: AI Tailored Resumes & Application Autofill`,
    description:
      `Open a job posting and ${PRODUCT_NAME} tailors your resume, fills the application, and drafts real outreach. You get the final say.`,
    version: EXTENSION_VERSION,
    // Keep this list minimal: every extra permission widens the install warning
    // and slows Chrome Web Store review. API calls go through the background
    // worker and rely on the backend's CORS, so no host_permissions in prod.
    // 'scripting' (no install-warning of its own) + the existing 'activeTab' power the
    // popup's "Fill the form on this page" button: the content script is injected on demand
    // into company-hosted career pages the manifest matches can't cover, only ever on the
    // tab the student invoked it from.
    permissions: ['activeTab', 'scripting', 'storage', 'clipboardWrite'],
    host_permissions: command === 'serve' ? ['http://localhost:3001/*'] : [],
    externally_connectable: {
      matches: [
        'https://trylitos.com/*',
        'https://www.trylitos.com/*',
        'https://role-quick-website.vercel.app/*',
        'http://localhost/*',
        'http://localhost:*/*',
      ],
    },
  }),
});
