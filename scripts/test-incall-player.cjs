// Executes the actual patched Java player/callback against a strict JVM fake.
// No Android SDK is needed. This is not a substitute for device/audio acceptance.
const fs = require('fs');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');

const modulePath = path.resolve(__dirname, '../node_modules/react-native-incall-manager/android/src/main/java/com/zxcpoiu/incallmanager/InCallManagerModule.java');
const source = fs.readFileSync(modulePath, 'utf8');
function blockAfter(marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing Java marker: ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  if (depth) throw new Error('Unbalanced Java block');
  return {whole: source.slice(start, end), body: source.slice(open + 1, end - 1)};
}

const player = blockAfter('private class myMediaPlayer').whole;
const prepared = blockAfter('public void onPrepared(MediaPlayer mp)').body;
const harness = `
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public class InCallPlayerHarness {
    static final String TAG = "test";
    static class Uri {}
    static class ReactContext {}
    static class Log { static void d(String tag, String text, Object... error) {} }
    static class AudioAttributes {
        static class Builder {
            Builder setUsage(int n) { return this; }
            Builder setContentType(int n) { return this; }
            AudioAttributes build() { return new AudioAttributes(); }
        }
    }
    static class AudioManager {
        static final int MODE_IN_COMMUNICATION = 3, MODE_RINGTONE = 1;
        int modes = 0;
        boolean isSpeakerphoneOn() { return false; }
        void setMode(int mode) { modes++; }
    }
    interface MyPlayerInterface {
        void stopPlay(); void startPlay(Map data); boolean isPlaying();
    }
    static class MediaPlayer {
        boolean ended, playing, invalid, failSource;
        int releases, starts, probes;
        CountDownLatch probeEntered, probeProceed;
        void live() { if (ended) throw new IllegalStateException("released"); }
        public void release() { live(); releases++; ended = true; playing = false; }
        public void stop() { throw new AssertionError("stop is invalid while preparing"); }
        public void reset() { throw new AssertionError("reset is unnecessary"); }
        public void setDataSource(ReactContext context, Uri uri) {
            live(); if (failSource) throw new IllegalArgumentException("bad source");
        }
        public void setLooping(boolean loop) { live(); }
        public void setAudioAttributes(AudioAttributes attrs) { live(); }
        public void prepareAsync() { live(); }
        public void start() { live(); starts++; playing = true; }
        public boolean isPlaying() {
            live(); probes++;
            if (probeEntered != null) { probeEntered.countDown(); await(probeProceed); }
            live(); if (invalid) throw new IllegalStateException("error state");
            return playing;
        }
    }
    final AudioManager audioManager = new AudioManager();
    ReactContext getReactApplicationContext() { return new ReactContext(); }
    void updateAudioRoute() {}
    ${player}
    void prepared(MediaPlayer mp, String name) { ${prepared} }
    static Map data() {
        Map<String,Object> data = new HashMap<>();
        data.put("sourceUri", new Uri()); data.put("setLooping", true);
        data.put("audioUsage", 1); data.put("audioContentType", 2); return data;
    }
    static void check(boolean ok, String label) {
        if (!ok) throw new AssertionError(label);
    }
    static void await(CountDownLatch latch) {
        try { check(latch.await(3, TimeUnit.SECONDS), "latch timed out"); }
        catch (InterruptedException e) { throw new AssertionError(e); }
    }
    void run() throws Exception {
        myMediaPlayer normal = new myMediaPlayer();
        normal.startPlay(data()); prepared(normal, "mRingtone");
        check(normal.isPlaying(), "normal playback"); normal.stopPlay();
        check(normal.releases == 1 && !normal.isPlaying(), "normal release");

        myMediaPlayer early = new myMediaPlayer(); early.startPlay(data());
        early.stopPlay(); early.stopPlay();
        int modes = audioManager.modes;
        prepared(early, "mRingtone"); early.startPlay(data());
        check(early.releases == 1 && early.starts == 0 && !early.isPlaying(),
            "stop during preparation is terminal/idempotent");
        check(audioManager.modes == modes, "stale callback cannot change audio mode");

        myMediaPlayer failed = new myMediaPlayer(); failed.failSource = true;
        failed.startPlay(data());
        check(failed.releases == 1 && !failed.isPlaying(), "failed setup releases resources");

        myMediaPlayer invalid = new myMediaPlayer(); invalid.invalid = true;
        check(!invalid.isPlaying() && invalid.releases == 1, "invalid state is safe");
        check(!invalid.isPlaying() && invalid.probes == 1, "invalid player never probed again");

        myMediaPlayer race = new myMediaPlayer(); race.playing = true;
        race.probeEntered = new CountDownLatch(1); race.probeProceed = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread probe = new Thread(() -> {
            try { race.isPlaying(); } catch (Throwable e) { failure.set(e); }
        });
        CountDownLatch stopping = new CountDownLatch(1);
        CountDownLatch stopped = new CountDownLatch(1);
        Thread stop = new Thread(() -> {
            stopping.countDown();
            try { race.stopPlay(); } catch (Throwable e) { failure.set(e); }
            finally { stopped.countDown(); }
        });
        probe.start(); await(race.probeEntered); stop.start(); await(stopping);
        check(!stopped.await(50, TimeUnit.MILLISECONDS), "release waits for query monitor");
        check(!race.ended, "release cannot overtake active isPlaying");
        race.probeProceed.countDown(); probe.join(3000); stop.join(3000);
        check(!probe.isAlive() && !stop.isAlive() && failure.get() == null,
            "concurrent query/release completes without exception");
        check(race.releases == 1 && !race.isPlaying(), "race releases once");
        System.out.println("PASS: native player lifecycle (normal, preparing stop, duplicate stop, stale callback, failed setup, invalid query, concurrent release)");
    }
    public static void main(String[] args) throws Exception { new InCallPlayerHarness().run(); }
}
`;

if (process.argv[2] === '--write-harness') {
  const target = process.argv[3];
  if (!target) throw new Error('--write-harness requires an output directory');
  fs.mkdirSync(target, {recursive: true});
  fs.writeFileSync(path.join(target, 'InCallPlayerHarness.java'), harness);
} else {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'incall-player-'));
  fs.writeFileSync(path.join(target, 'InCallPlayerHarness.java'), harness);
  const bin = name => process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', name) : name;
  execFileSync(bin('javac'), ['InCallPlayerHarness.java'], {cwd: target, stdio: 'inherit'});
  execFileSync(bin('java'), ['-cp', target, 'InCallPlayerHarness'], {stdio: 'inherit'});
}
