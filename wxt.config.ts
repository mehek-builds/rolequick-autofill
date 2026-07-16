import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: ({ command }) => ({
    name: 'RoleQuick: AI Tailored Resumes & Application Autofill',
    description:
      "Open a job posting and RoleQuick's AI tailors your resume, fills the application, and drafts real outreach. You get the final say.",
    version: '0.3.5',
    // Keep this list minimal: every extra permission widens the install warning
    // and slows Chrome Web Store review. API calls go through the background
    // worker and rely on the backend's CORS, so no host_permissions in prod.
    // 'scripting' (no install-warning of its own) + the existing 'activeTab' power the
    // popup's "Fill the form on this page" button: the content script is injected on demand
    // into company-hosted career pages the manifest matches can't cover, only ever on the
    // tab the student invoked it from.
    permissions: ['activeTab', 'scripting', 'storage', 'clipboardWrite'],
    host_permissions: command === 'serve' ? ['http://localhost:3001/*'] : [],
  }),
});
