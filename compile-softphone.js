const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const ejsPath = 'C:/Users/0xSiTe/Desktop/sokrat-voice/views/index.ejs';
const template = fs.readFileSync(ejsPath, 'utf8');

// Render using official EJS compiler with all variables
const data = {
    currentLang: 'en',
    isRtl: false,
    extensions: [
        { extension: '150', name: '150 (WebRTC)', tech: 'pjsip' },
        { extension: '101', name: '101 (Support)', tech: 'pjsip' },
        { extension: '102', name: '102 (Sales)', tech: 'pjsip' }
    ],
    host: '192.168.100.128',
    version: '2.0.0',
    currentVersion: 'v2.0.0'
};

let compiled = ejs.render(template, data);

// 1. Remove HTTP -> HTTPS redirect (local file:// environment)
compiled = compiled.replace(/<script>\s*\/\/ Automatic HTTPS upgrade[\s\S]*?<\/script>/, '<!-- Local Mobile App Mode -->');

// 2. Set mobile responsive full-screen classes
compiled = compiled.replace('<html lang="en" dir="ltr">', '<html lang="en" dir="ltr" class="is-popout">');
compiled = compiled.replace('<body>', '<body class="is-popout">');

// 3. Inject mobile bridge and auto-open accounts/login modal on fresh startup
const bridge = `
<script>
// --- Sokrat Mobile Native Bridge ---
window.isReactNativeMobile = true;
window.addEventListener('DOMContentLoaded', () => {
    // Mobile touch and audio optimization
    document.addEventListener('touchstart', function() {}, { passive: true });
    
    setTimeout(() => {
        if (window.softphoneUI) {
            // Hook registration state changes to sync FCM token with native Android
            const origSetRegState = window.softphoneUI.core.setRegState.bind(window.softphoneUI.core);
            window.softphoneUI.core.setRegState = function(state) {
                origSetRegState(state);
                if (window.ReactNativeWebView) {
                    window.ReactNativeWebView.postMessage(JSON.stringify({
                        type: 'REG_STATE_CHANGE',
                        state: state,
                        extension: window.softphoneUI.core.activePreset?.extension || ''
                    }));
                }
            };

            // Auto-open accounts/login modal if not currently registered
            if (!window.softphoneUI.core.isRegistered()) {
                const presets = window.softphoneUI.loadPresets();
                if (!presets || presets.length === 0) {
                    window.softphoneUI.openPresetModal('add');
                }
            }
        }
    }, 400);
});
</script>
`;

compiled = compiled.replace('</body>', bridge + '\n</body>');

const outDir = path.join(__dirname, 'android/app/src/main/assets/sokrat-voice');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), compiled, 'utf8');

console.log('Successfully compiled Sokrat Voice to:', path.join(outDir, 'index.html'));
console.log('File size:', compiled.length, 'bytes');
