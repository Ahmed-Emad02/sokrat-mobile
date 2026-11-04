'use strict';
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'node_modules', 'react-native-incall-manager',
  'android', 'src', 'main', 'java', 'com', 'zxcpoiu', 'incallmanager', 'InCallManagerModule.java');
const source = fs.readFileSync(file, 'utf8');
const start = '            UiThreadUtil.runOnUiThread(() -> {\n' +
  '                bluetoothManager.start();\n' +
  '            });\n';
const guarded = '            UiThreadUtil.runOnUiThread(() -> {\n' +
  '                // Sokrat: the Android native communication-device backend owns\n' +
  '                // routing. Starting this manager with auto=false still lets its\n' +
  '                // headset callbacks call updateAudioDeviceState() directly.\n' +
  '                if (automatic) {\n' +
  '                    bluetoothManager.start();\n' +
  '                }\n' +
  '            });\n';
if (source.includes(guarded)) process.exit(0);
if (!source.includes(start)) {
  throw new Error('IncCallManager start block changed; refusing to patch blindly');
}
fs.writeFileSync(file, source.replace(start, guarded));
