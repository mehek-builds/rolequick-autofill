import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Volley - Student Outreach',
    description: 'Find the right humans at any company and send personalized outreach in seconds.',
    version: '0.1.0',
    permissions: ['activeTab', 'scripting', 'storage', 'clipboardWrite'],
    host_permissions: [
      '<all_urls>',
      'http://localhost:3001/*',
    ],
  },
});
