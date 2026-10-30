const fs = require('fs');
const path = require('path');

it('retains RNFirebase token-refresh delivery when replacing its manifest service', () => {
  const source = fs.readFileSync(path.join(__dirname,
    '../android/app/src/main/java/com/sokratmobile/SokratFirebaseMessagingService.kt'), 'utf8');
  expect(source).toMatch(/class SokratFirebaseMessagingService\s*:\s*ReactNativeFirebaseMessagingService\(\)/);
  expect(source).toMatch(/override fun onNewToken\(token: String\)[\s\S]*super\.onNewToken\(token\)/);
});

it('checks push call IDs before native persistence, presentation, or bootstrap', () => {
  const source = fs.readFileSync(path.join(__dirname,
    '../android/app/src/main/java/com/sokratmobile/SokratFirebaseMessagingService.kt'), 'utf8');
  expect(source).toMatch(/if\s*\(!PushCallIdValidator\.isValid\(callId\)\)\s*\{[^}]*return\s*\}/);
  const guard = source.indexOf('PushCallIdValidator.isValid(callId)');
  expect(guard).toBeLessThan(source.indexOf('IncomingCallStore.upsertIncoming'));
  expect(guard).toBeLessThan(source.indexOf('IncomingCallNotificationHelper.showCallNotification'));
  expect(guard).toBeLessThan(source.indexOf('IncomingCallStore.claimBootstrap'));
});
