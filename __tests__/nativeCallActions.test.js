const fs = require('fs');
const path = require('path');

const native = path.join(__dirname, '../android/app/src/main/java/com/sokratmobile');
const read = name => fs.readFileSync(path.join(native, name), 'utf8');

test('incoming call notification actions use direct activity intents', () => {
  const helper = read('IncomingCallNotificationHelper.kt');
  const show = helper.slice(
    helper.indexOf('fun showCallNotification'),
    helper.indexOf('fun dismissCallNotification'),
  );

  expect(show).toContain('val answerPendingIntent = PendingIntent.getActivity');
  expect(show).toContain('val declinePendingIntent = PendingIntent.getActivity');
  expect(show).toContain('"com.sokratmobile.ACTION_ANSWER_CALL", "ANSWER"');
  expect(show).toContain('"com.sokratmobile.ACTION_DECLINE_CALL", "DECLINE"');
  expect(show).not.toContain('PendingIntent.getBroadcast');
});

test('the notification action receiver is not exported', () => {
  const manifest = fs.readFileSync(
    path.join(__dirname, '../android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  expect(manifest).toMatch(
    /android:name="\.CallActionReceiver"\s+android:exported="false"/,
  );
});
