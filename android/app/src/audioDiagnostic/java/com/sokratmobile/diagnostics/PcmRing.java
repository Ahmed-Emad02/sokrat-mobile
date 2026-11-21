package com.sokratmobile.diagnostics;

import java.nio.ByteBuffer;

/**
 * Bounded, preallocated single-producer/single-consumer PCM queue.
 *
 * The AudioTrack thread owns offer(); the file worker owns poll(). Volatile
 * sequence publication transfers slot ownership without making the audio thread
 * wait for the lower-priority file worker. Only a full queue or invalid input
 * drops a capture chunk. Sequence gaps identify rejected open-queue offers.
 */
public final class PcmRing {
    public static final class Chunk {
        public final byte[] data;
        public int size;
        public int written;
        public long startNs;
        public long endNs;
        public long sequence;

        public Chunk(int maxBytes) {
            if (maxBytes <= 0) throw new IllegalArgumentException("maxBytes must be positive");
            data = new byte[maxBytes];
        }
    }

    private final Chunk[] slots;
    private final int capacity;
    private final int maxBytes;
    private volatile long readSequence;
    private volatile long writeSequence;
    private volatile long dropped;
    private volatile boolean closed;
    private volatile boolean producerActive;
    private long nextSequence;

    public PcmRing(int capacity, int maxBytes) {
        if (capacity <= 0 || maxBytes <= 0) throw new IllegalArgumentException("Positive queue dimensions required");
        this.capacity = capacity;
        this.maxBytes = maxBytes;
        slots = new Chunk[capacity];
        for (int i = 0; i < capacity; i++) slots[i] = new Chunk(maxBytes);
    }

    /** Copies an absolute byte range, preserving the caller's position and limit. Never waits or allocates. */
    public boolean offer(ByteBuffer source, int offset, int size, long startNs, long endNs, int written) {
        // Publish before checking closed: the consumer must not finish draining
        // while an offer that began before close() is still publishing its slot.
        producerActive = true;
        try {
            if (closed) return false;
            long sequence = nextSequence++;
            if (source == null || offset < 0 || size <= 0 || size > maxBytes || offset > source.limit() - size) {
                dropped++;
                return false;
            }
            long tail = writeSequence;
            if (tail - readSequence >= capacity) {
                dropped++;
                return false;
            }
            Chunk slot = slots[(int) (tail % capacity)];
            int position = source.position();
            try {
                source.position(offset);
                source.get(slot.data, 0, size);
            } finally {
                source.position(position);
            }
            slot.size = size;
            slot.written = written;
            slot.startNs = startNs;
            slot.endNs = endNs;
            slot.sequence = sequence;
            // Release the initialized slot to the consumer.
            writeSequence = tail + 1;
            return true;
        } finally {
            producerActive = false;
        }
    }

    /** Copies the oldest slot before releasing it back to the producer. */
    public boolean poll(Chunk target) {
        if (target == null) throw new NullPointerException("target");
        long head = readSequence;
        if (head == writeSequence) return false;
        Chunk slot = slots[(int) (head % capacity)];
        if (target.data.length < slot.size) throw new IllegalArgumentException("Consumer chunk too small");
        System.arraycopy(slot.data, 0, target.data, 0, slot.size);
        target.size = slot.size;
        target.written = slot.written;
        target.startNs = slot.startNs;
        target.endNs = slot.endNs;
        target.sequence = slot.sequence;
        // The producer may reuse this slot only after the copy has finished.
        readSequence = head + 1;
        return true;
    }

    /** Rejects new offers; an already active producer may finish publishing its last slot. */
    public void close() {
        closed = true;
    }

    public boolean isDrained() {
        return closed && !producerActive && readSequence == writeSequence;
    }

    public long dropped() {
        return dropped;
    }
}
