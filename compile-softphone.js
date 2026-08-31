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
// 3. Inject mobile full-height stretch CSS & Tab Scoping
const stretchCss = `
<style>
/* --- Sokrat Mobile Full-Height Stretch & Tab Isolation --- */
html, body, html.is-popout, body.is-popout {
    width: 100vw !important;
    height: 100vh !important;
    min-height: 100vh !important;
    max-height: 100vh !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: hidden !important;
    display: flex !important;
    flex-direction: column !important;
}

.app-window, html.is-popout .app-window, body.is-popout .app-window {
    width: 100vw !important;
    max-width: 100vw !important;
    height: 100vh !important;
    min-height: 100vh !important;
    max-height: 100vh !important;
    border-radius: 0 !important;
    border: none !important;
    box-shadow: none !important;
    display: flex !important;
    flex-direction: column !important;
    flex: 1 !important;
    overflow: hidden !important;
}

.app-body {
    flex: 1 !important;
    display: flex !important;
    flex-direction: column !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    overflow-x: hidden !important;
}

.workspace {
    flex: 1 !important;
    display: flex !important;
    flex-direction: column !important;
    min-height: 0 !important;
    overflow: hidden !important;
}

/* Strict Tab View Scoping: Only .active tab is visible */
.tab-view-content {
    display: none !important;
}

.tab-view-content.active {
    display: flex !important;
    flex-direction: column !important;
    flex: 1 !important;
    min-height: 0 !important;
    height: 100% !important;
    overflow-y: auto !important;
}

#tabContentDialer.active {
    display: flex !important;
    flex-direction: column !important;
    flex: 1 !important;
    justify-content: space-between !important;
    padding: 6px 12px 8px !important;
}

.dialer-col {
    flex: 1 !important;
    display: flex !important;
    flex-direction: column !important;
    justify-content: space-between !important;
    width: 100% !important;
    max-width: 100% !important;
    min-height: 0 !important;
}

.dialer-input-box {
    margin-bottom: 6px !important;
}

.keypad-grid {
    flex: 1 !important;
    display: grid !important;
    grid-template-columns: repeat(3, 1fr) !important;
    grid-auto-rows: 1fr !important;
    gap: 6px !important;
    margin: 4px 0 6px !important;
    min-height: 180px !important;
}

.keypad-btn {
    height: 100% !important;
    min-height: 44px !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    justify-content: center !important;
}

.keypad-action-row {
    margin-bottom: 6px !important;
}

.dialer-tool-bar {
    margin-bottom: 6px !important;
}

.dual-vu-meters-deck {
    margin-top: auto !important;
    padding-bottom: 4px !important;
}
</style>
`;
compiled = compiled.replace('</head>', stretchCss + '\n</head>');
// 4. Inject mobile bridge and auto-open accounts/login modal on fresh startup
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
