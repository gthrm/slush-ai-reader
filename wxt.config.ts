import { defineConfig } from 'wxt';
export default defineConfig({
  manifest: {
    name: 'Slush — listen to the web', description: 'Understands web pages and reads them naturally, with a convenient audio player.',
    permissions: ['activeTab', 'scripting', 'storage', 'offscreen'],
    host_permissions: ['http://*/*', 'https://*/*'],
    minimum_chrome_version: '127',
    icons: { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' },
    action: { default_title: 'Slush — listen to this page' },
    commands: { 'toggle-playback': { suggested_key: { default: 'Alt+Shift+P' }, description: 'Pause / resume reading' } },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; connect-src https://api.openai.com; media-src 'self' blob:;" },
  },
});
