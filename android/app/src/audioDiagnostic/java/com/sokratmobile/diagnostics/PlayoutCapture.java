package com.sokratmobile.diagnostics;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Process;
import android.util.Log;
import java.io.BufferedOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Opt-in pre-AudioTrack PCM evidence. Present only in audioDiagnostic builds. */
public final class PlayoutCapture {
    private static final String TAG = "SokratPcm";
    private static volatile Session current;

    private PlayoutCapture() {}

    public static synchronized void start(Context context, int durationSeconds) {
        if (current != null) {
            Log.w(TAG, "Capture already active or draining");
            return;
        }
        // Older shared-storage models do not isolate app-specific external call recordings.
        if (Build.VERSION.SDK_INT < 30) {
            Log.w(TAG, "Capture requires Android 11 or newer; capture not armed");
            return;
        }
        File external = context.getExternalFilesDir(null);
        if (external == null) {
            Log.w(TAG, "External app files unavailable; capture not armed");
            return;
        }
        File directory = new File(external, "audio-diagnostics");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            Log.w(TAG, "Cannot create diagnostic directory; capture not armed");
            return;
        }
        Session session = new Session(directory, Math.max(1, Math.min(600, durationSeconds)));
        current = session;
        new Thread(session, "SokratPcmWriter").start();
    }

    public static void stop() {
        Session session = current;
        if (session != null) session.requestStop("requested");
    }

    /** Same return value, buffer position and exceptions as the original AudioTrack.write. */
    public static int write(AudioTrack track, ByteBuffer buffer, int size, int mode) {
        Session session = current;
        if (session == null || !session.beginWrite()) return track.write(buffer, size, mode);
        try {
            int offset = buffer.position();
            long startNs = System.nanoTime();
            int written = track.write(buffer, size, mode);
            long endNs = System.nanoTime();
            // Capture faults must never turn a successful playout write into a call failure.
            try {
                session.offer(track, buffer, offset, size, startNs, endNs, written);
            } catch (RuntimeException ignored) {
                session.requestStop("capture_error");
            }
            return written;
        } finally {
            session.admission.leave();
        }
    }

    private static final class Session implements Runnable {
        private final PcmRing ring = new PcmRing(128, 8192);
        private final CaptureAdmission admission = new CaptureAdmission();
        private final long armedUnixMs = System.currentTimeMillis();
        private final long armedNanoNs = System.nanoTime();
        private final long deadlineNs;
        private final int durationSeconds;
        private final File directory;
        private final String basename;
        private volatile boolean stopRequested;
        private volatile String stopReason = "deadline";
        // Only the producer binds the track; ring publication makes format visible to the writer.
        private final AtomicReference<AudioTrack> boundTrack = new AtomicReference<>();
        private int sampleRate;
        private int channels;
        private int encoding;

        Session(File directory, int durationSeconds) {
            this.directory = directory;
            this.durationSeconds = durationSeconds;
            basename = "playout-" + armedUnixMs;
            deadlineNs = armedNanoNs + durationSeconds * 1_000_000_000L;
        }

        boolean beginWrite() {
            if (!stopRequested && System.nanoTime() >= deadlineNs) requestStop("deadline");
            return admission.enter();
        }

        void requestStop(String reason) {
            stopReason = reason;
            admission.close();
            stopRequested = true;
        }

        // Only a requested stop or the duration limit ends a recording as a complete capture.
        private boolean endedByRequestOrDeadline() {
            return "requested".equals(stopReason) || "deadline".equals(stopReason);
        }

        void offer(AudioTrack track, ByteBuffer buffer, int offset, int size,
                   long startNs, long endNs, int written) {
            AudioTrack existingTrack = boundTrack.get();
            if (existingTrack == null) {
                if (!boundTrack.compareAndSet(null, track)) {
                    requestStop("concurrent_output_tracks");
                    return;
                }
                sampleRate = track.getSampleRate();
                channels = track.getChannelCount();
                encoding = track.getAudioFormat();
                if (encoding != AudioFormat.ENCODING_PCM_16BIT) {
                    requestStop("unsupported_encoding");
                    return;
                }
            } else if (existingTrack != track) {
                requestStop("output_track_replaced");
                return;
            }
            ring.offer(buffer, offset, size, startNs, endNs, written);
        }

        @Override public void run() {
            long pcmBytes = 0;
            long frames = 0;
            long shortWrites = 0;
            long firstWriteNs = 0;
            long lastWriteNs = 0;
            long previousWriteNs = 0;
            long maxWriteNs = 0;
            long maxInterWriteNs = 0;
            long drainStartedNs = 0;
            boolean drainTimedOut = false;
            PcmRing.Chunk chunk = new PcmRing.Chunk(8192);
            File pcmFile = new File(directory, basename + ".pcm");
            File timelineFile = new File(directory, basename + ".timing");
            boolean complete = false;
            try (BufferedOutputStream pcm = new BufferedOutputStream(new FileOutputStream(pcmFile), 32768);
                 DataOutputStream timeline = new DataOutputStream(new BufferedOutputStream(
                         new FileOutputStream(timelineFile), 32768))) {
                Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND);
                timeline.writeInt(0x5350434d); // SPCM
                timeline.writeInt(1);
                Log.i(TAG, "READY file=" + pcmFile + " durationSeconds=" + durationSeconds);
                while (true) {
                    long now = System.nanoTime();
                    if (!stopRequested && now >= deadlineNs) requestStop("deadline");
                    if (stopRequested) {
                        if (drainStartedNs == 0) drainStartedNs = now;
                        if (admission.isDrained()) {
                            ring.close();
                        } else if (now - drainStartedNs >= 1_000_000_000L) {
                            // Bound shutdown even if Android never returns an in-flight write.
                            drainTimedOut = true;
                            ring.close();
                        }
                    }
                    if (!ring.poll(chunk)) {
                        if (ring.isDrained()) break;
                        Thread.sleep(10);
                        continue;
                    }
                    pcm.write(chunk.data, 0, chunk.size);
                    timeline.writeLong(chunk.sequence);
                    timeline.writeLong(chunk.startNs);
                    timeline.writeLong(chunk.endNs);
                    timeline.writeInt(chunk.size);
                    timeline.writeInt(chunk.written);
                    pcmBytes += chunk.size;
                    frames++;
                    if (chunk.written != chunk.size) shortWrites++;
                    if (firstWriteNs == 0) firstWriteNs = chunk.startNs;
                    if (previousWriteNs != 0) maxInterWriteNs = Math.max(maxInterWriteNs, chunk.startNs - previousWriteNs);
                    maxWriteNs = Math.max(maxWriteNs, chunk.endNs - chunk.startNs);
                    previousWriteNs = chunk.startNs;
                    lastWriteNs = chunk.endNs;
                }
                complete = true;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                stopReason = "writer_interrupted";
                Log.w(TAG, "Diagnostic writer interrupted");
            } catch (IOException | RuntimeException e) {
                complete = false;
                stopReason = "writer_error";
                Log.w(TAG, "Diagnostic write failed", e);
            } finally {
                admission.close();
                ring.close();
                stopRequested = true;
                try {
                    JSONObject metadata = new JSONObject();
                    metadata.put("sampleRate", sampleRate);
                    metadata.put("channels", channels);
                    metadata.put("encoding", encoding);
                    metadata.put("byteOrder", ByteOrder.nativeOrder().toString());
                    metadata.put("bytesPerSample", 2);
                    metadata.put("armedUnixMs", armedUnixMs);
                    metadata.put("armedNanoNs", armedNanoNs);
                    metadata.put("durationLimitSeconds", durationSeconds);
                    metadata.put("firstWriteNs", firstWriteNs);
                    metadata.put("lastWriteNs", lastWriteNs);
                    metadata.put("pcmBytes", pcmBytes);
                    metadata.put("frames", frames);
                    metadata.put("timingFormat", "SPCM v1: 8-byte big-endian magic/version header, then >qqqii sequence,startNs,endNs,requestedBytes,writtenBytes");
                    metadata.put("droppedCaptureFrames", ring.dropped());
                    metadata.put("shortAudioTrackWrites", shortWrites);
                    metadata.put("maxAudioTrackWriteMs", maxWriteNs / 1_000_000.0);
                    metadata.put("maxInterWriteStartMs", maxInterWriteNs / 1_000_000.0);
                    metadata.put("stopReason", stopReason);
                    metadata.put("filesClosedNormally", complete);
                    metadata.put("drainTimedOut", drainTimedOut);
                    metadata.put("unfinishedCaptureCallbacks", admission.pending());
                    metadata.put("captureComplete", complete && !drainTimedOut && admission.isDrained()
                            && ring.dropped() == 0 && endedByRequestOrDeadline());
                    metadata.put("tap", "PCM requested by WebRTC immediately before AudioTrack.write; copied after write without changing buffer position");
                    try (OutputStreamWriter output = new OutputStreamWriter(new FileOutputStream(
                            new File(directory, basename + ".json")), StandardCharsets.UTF_8)) {
                        output.write(metadata.toString(2));
                    }
                    Log.i(TAG, "DONE file=" + pcmFile + " frames=" + frames + " captureDrops=" + ring.dropped());
                } catch (Exception e) {
                    Log.w(TAG, "Cannot write diagnostic metadata", e);
                }
                synchronized (PlayoutCapture.class) {
                    if (current == this) current = null;
                }
            }
        }
    }
}
