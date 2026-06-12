import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: ({ command }) => ({
    name: 'Volley - Student Outreach',
    description: 'Find the right humans at any company and send personalized outreach in seconds.',
    version: '0.2.0',
    // Keep this list minimal: every extra permission widens the install warning
    // and slows Chrome Web Store review. API calls go through the background
    // worker and rely on the backend's CORS, so no host_permissions in prod.
    permissions: ['activeTab', 'storage', 'clipboardWrite'],
    host_permissions: command === 'serve' ? ['http://localhost:3001/*'] : [],
  }),
});
