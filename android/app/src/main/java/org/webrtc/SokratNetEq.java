package org.webrtc;

import android.util.Log;

/** App-owned policy for the pinned WebRTC 124 audio receiver. */
public final class SokratNetEq {
  static {
    System.loadLibrary("sokrat_neteq");
  }

  private SokratNetEq() {}

  // Called at the end of RtpReceiver construction, before the receiver escapes
  // to JsSIP. This covers incoming, outgoing and replacement audio receivers.
  public static void configure(RtpReceiver receiver) {
    MediaStreamTrack track = receiver.track();
    if (track != null && "audio".equals(track.kind())) {
      nativeSetMinimumDelay(receiver.getNativeRtpReceiver());
      Log.i("SokratNetEq", "Requested 200 ms audio jitter-buffer minimum");
    }
  }

  private static native void nativeSetMinimumDelay(long receiver);
}
