const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root,
  'node_modules/react-native-incall-manager/android/src/main/java/com/zxcpoiu/incallmanager/InCallManagerModule.java'), 'utf8');

it('pins the patched dependency and installs the native lifecycle patch on clean installs', () => {
  const pkg = require('../package.json');
  expect(pkg.dependencies['react-native-incall-manager']).toBe('4.2.2');
  expect(pkg.scripts.postinstall).toContain('patch-package');
  const patch = fs.readFileSync(path.join(root, 'patches/react-native-incall-manager+4.2.2.patch'), 'utf8');
  expect(patch).toContain('+        public synchronized void stopPlay()');
  expect(patch).toContain('+        public synchronized boolean isPlaying()');
});

it('Answer cancels even a preparing ringtone without a native isPlaying query', () => {
  const start = source.slice(source.indexOf('public void start(final String _media'), source.indexOf('public void stop()'));
  expect(start).not.toContain('mRingtone.isPlaying()');
  expect(start).toMatch(/synchronized \(ringtoneLock\)[\s\S]*stopRingtone\(\)/);
});

it('detaches the ringtone synchronously and cancels queued starts and stale timeouts', () => {
  const stop = source.slice(source.indexOf('public void stopRingtone()'), source.indexOf('private void setMediaPlayerEvents'));
  expect(stop).not.toContain('new Thread');
  expect(stop).toMatch(/mRingtone = null;[\s\S]*ringtone\.stopPlay\(\)/);
  expect(stop).toContain('++ringtoneGeneration');
  expect(stop).toContain('getLooper().quitSafely()');
  expect(source).toContain('generation != ringtoneGeneration');
  expect(source).toContain('if (mRingtone != ringtone)');
  expect(source).toContain('A late ringtone must not tear down answered call audio');
});

it('serializes late prepare callbacks with release before changing routing or starting', () => {
  const prepared = source.slice(source.indexOf('public void onPrepared(MediaPlayer mp)'), source.indexOf('mp.setOnCompletionListener'));
  expect(prepared).toMatch(/synchronized \(mp\)[\s\S]*\.released[\s\S]*audioManager\.setMode[\s\S]*mp\.start\(\)/);
  expect(prepared).toContain('catch (IllegalStateException e)');
  const player = source.slice(source.indexOf('private class myMediaPlayer'), source.indexOf('// ===== Internal Classes End'));
  expect(player).toContain('public synchronized void startPlay');
  expect(player).toMatch(/released = true;[\s\S]*super\.release\(\)/);
  expect(player).not.toMatch(/^\s+(stop|reset)\(\);/m);
});
