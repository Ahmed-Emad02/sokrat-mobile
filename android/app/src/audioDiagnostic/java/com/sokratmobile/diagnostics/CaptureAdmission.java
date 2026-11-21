package com.sokratmobile.diagnostics;

import java.util.concurrent.atomic.AtomicInteger;

/** Stops new callbacks without losing an already admitted AudioTrack write. */
final class CaptureAdmission {
    private final AtomicInteger active = new AtomicInteger();
    private volatile boolean closed;

    boolean enter() {
        active.incrementAndGet();
        if (closed) {
            active.decrementAndGet();
            return false;
        }
        return true;
    }

    void leave() {
        active.decrementAndGet();
    }

    void close() {
        closed = true;
    }

    boolean isDrained() {
        return closed && active.get() == 0;
    }

    int pending() {
        return active.get();
    }
}
