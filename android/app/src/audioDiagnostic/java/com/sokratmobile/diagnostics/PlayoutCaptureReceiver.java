package com.sokratmobile.diagnostics;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Explicit, adb-only control for the temporary playout capture.
 *
 * <p>This receiver exists only in the audioDiagnostic build type (see
 * src/audioDiagnostic). The manifest export requires the sender to hold
 * {@code android.permission.DUMP}, so only adb shell / the system can trigger
 * it; capture never starts implicitly and no caller-supplied file path is
 * honoured.
 *
 * <pre>
 * adb shell am broadcast -a com.sokratmobile.AUDIO_DIAGNOSTIC_START --ei durationSeconds 240
 * adb shell am broadcast -a com.sokratmobile.AUDIO_DIAGNOSTIC_STOP
 * </pre>
 */
public final class PlayoutCaptureReceiver extends BroadcastReceiver {

    public static final String ACTION_START = "com.sokratmobile.AUDIO_DIAGNOSTIC_START";
    public static final String ACTION_STOP = "com.sokratmobile.AUDIO_DIAGNOSTIC_STOP";
    public static final String EXTRA_DURATION_SECONDS = "durationSeconds";

    private static final int DEFAULT_DURATION_SECONDS = 240;
    private static final int MIN_DURATION_SECONDS = 1;
    private static final int MAX_DURATION_SECONDS = 600;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            return;
        }
        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            int durationSeconds = intent.getIntExtra(EXTRA_DURATION_SECONDS, DEFAULT_DURATION_SECONDS);
            if (durationSeconds < MIN_DURATION_SECONDS) {
                durationSeconds = MIN_DURATION_SECONDS;
            } else if (durationSeconds > MAX_DURATION_SECONDS) {
                durationSeconds = MAX_DURATION_SECONDS;
            }
            PlayoutCapture.start(context.getApplicationContext(), durationSeconds);
        } else if (ACTION_STOP.equals(action)) {
            PlayoutCapture.stop();
        }
    }
}
