const fs = require('fs');
const path = require('path');
const native = path.join(__dirname, '../android/app/src/main/java/com/sokratmobile');
const read = name => fs.readFileSync(path.join(native, name), 'utf8');

test('ongoing end has a distinct durable action and is not dismissed before SIP handles it', () => {
  const helper = read('IncomingCallNotificationHelper.kt');
  const ongoing = helper.slice(helper.indexOf('fun showOngoingCallNotification'), helper.indexOf('fun dismissOngoingCallNotification'));
  expect(ongoing).toContain('com.sokratmobile.ACTION_END_CALL');
  const receiver = read('CallActionReceiver.kt');
  expect(receiver).toContain('if (ongoing) "END" else "DECLINE"');
  expect(receiver).toContain('IncomingCallStore.upsertIncoming');
  expect(receiver).toContain('IncomingCallStore.setAction(context, canonicalCallId, action)');
  expect(receiver).not.toContain('dismissOngoingCallNotification');
  expect(read('IncomingCallStore.kt')).toContain('action != "END"');
});
