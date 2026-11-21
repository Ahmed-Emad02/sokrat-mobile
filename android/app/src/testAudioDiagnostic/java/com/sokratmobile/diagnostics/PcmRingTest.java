package com.sokratmobile.diagnostics;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.Test;

/** Deterministic invariants for the diagnostic PCM tap ring: no corruption, no silent loss, no reordering. */
public class PcmRingTest {

    /** Builds {@code size} bytes starting at {@code marker}, mimicking one captured PCM frame. */
    private static ByteBuffer frame(int marker, int size) {
        ByteBuffer buffer = ByteBuffer.allocate(size);
        for (int i = 0; i < size; i++) {
            buffer.put((byte) (marker + i));
        }
        buffer.flip();
        return buffer;
    }

    @Test
    public void offerCopiesRequestedRangeAndPreservesSourcePositionAndLimit() {
        ByteBuffer source = ByteBuffer.allocate(16);
        for (int i = 0; i < 12; i++) {
            source.put((byte) (0x40 + i));
        }
        source.position(5);
        int positionBefore = source.position();
        int limitBefore = source.limit();

        PcmRing ring = new PcmRing(2, 8);
        assertTrue(ring.offer(source, 2, 6, 1_000L, 2_000L, 6));

        assertEquals(positionBefore, source.position());
        assertEquals(limitBefore, source.limit());

        PcmRing.Chunk chunk = new PcmRing.Chunk(8);
        assertTrue(ring.poll(chunk));
        assertEquals(6, chunk.size);
        assertEquals(6, chunk.written);
        assertEquals(1_000L, chunk.startNs);
        assertEquals(2_000L, chunk.endNs);
        assertEquals(0L, chunk.sequence);
        assertArrayEquals(
                new byte[] {(byte) 0x42, (byte) 0x43, (byte) 0x44, (byte) 0x45, (byte) 0x46, (byte) 0x47},
                copyOf(chunk.data, chunk.size));
    }

    @Test
    public void overflowRejectsNewestKeepsOldestAndLeavesSequenceGap() {
        PcmRing ring = new PcmRing(2, 4);
        assertTrue(ring.offer(frame(1, 4), 0, 4, 10L, 20L, 4));
        assertTrue(ring.offer(frame(2, 4), 0, 4, 30L, 40L, 4));
        // Ring full: newest frame is dropped, older frames keep their bytes and slots.
        assertFalse(ring.offer(frame(3, 4), 0, 4, 50L, 60L, 4));
        assertEquals(1L, ring.dropped());

        PcmRing.Chunk chunk = new PcmRing.Chunk(4);
        assertTrue(ring.poll(chunk));
        assertEquals(1, chunk.data[0]);
        assertEquals(0L, chunk.sequence);
        assertTrue(ring.poll(chunk));
        assertEquals(2, chunk.data[0]);
        assertEquals(1L, chunk.sequence);
        assertFalse(ring.poll(chunk));

        assertTrue(ring.offer(frame(4, 4), 0, 4, 70L, 80L, 4));
        assertTrue(ring.poll(chunk));
        assertEquals(4, chunk.data[0]);
        assertEquals(3L, chunk.sequence);
        // One sequence number was consumed by the rejected offer, so the gap matches the drop count.
        assertEquals(ring.dropped(), chunk.sequence - 1L - 1L);
    }

    @Test
    public void wraparoundKeepsFifoByteOrder() {
        PcmRing ring = new PcmRing(3, 2);
        for (int i = 1; i <= 3; i++) {
            assertTrue(ring.offer(frame(i, 2), 0, 2, i * 10L, i * 10L + 5L, 2));
        }
        PcmRing.Chunk chunk = new PcmRing.Chunk(2);
        assertTrue(ring.poll(chunk));
        assertEquals(1, chunk.data[0]);
        assertTrue(ring.offer(frame(4, 2), 0, 2, 40L, 45L, 2));

        for (int i = 2; i <= 4; i++) {
            assertTrue(ring.poll(chunk));
            assertEquals(i, chunk.data[0]);
            assertEquals(i + 1, chunk.data[1]);
            assertEquals(i - 1L, chunk.sequence);
            assertEquals(i * 10L, chunk.startNs);
        }
        assertFalse(ring.poll(chunk));
        assertEquals(0L, ring.dropped());
    }

    @Test
    public void directReadOnlyNativeBufferCanBeCapturedWithoutChangingItsCursor() {
        ByteBuffer source = ByteBuffer.allocateDirect(8);
        source.put(new byte[] {1, 2, 3, 4, 5, 6, 7, 8});
        source.flip();
        source = source.asReadOnlyBuffer();
        source.position(3);
        PcmRing ring = new PcmRing(2, 4);
        assertTrue(ring.offer(source, 2, 4, 10L, 20L, 4));
        PcmRing.Chunk chunk = new PcmRing.Chunk(4);
        assertTrue(ring.poll(chunk));
        assertArrayEquals(new byte[] {3, 4, 5, 6}, copyOf(chunk.data, chunk.size));
        assertEquals(3, source.position());
        assertEquals(8, source.limit());
    }

    @Test
    public void closeRejectsNewOffersButDrainsQueuedAudio() {
        PcmRing ring = new PcmRing(2, 2);
        assertTrue(ring.offer(frame(7, 2), 0, 2, 0L, 5L, 2));
        assertFalse(ring.isDrained());

        ring.close();
        assertFalse(ring.isDrained());
        assertFalse(ring.offer(frame(8, 2), 0, 2, 5L, 10L, 2));
        assertEquals(0L, ring.dropped());
        ring.close();

        PcmRing.Chunk chunk = new PcmRing.Chunk(2);
        assertTrue(ring.poll(chunk));
        assertEquals(7, chunk.data[0]);
        assertTrue(ring.isDrained());
        assertFalse(ring.poll(chunk));
    }

    @Test
    public void invalidBoundsAndOversizeAreRejectedWithoutQueueing() {
        PcmRing ring = new PcmRing(2, 4);
        ByteBuffer source = frame(0x10, 4);
        source.position(2);
        int positionBefore = source.position();
        PcmRing.Chunk chunk = new PcmRing.Chunk(4);

        assertFalse(ring.offer(null, 0, 1, 0L, 0L, 1));
        assertFalse(ring.offer(source, -1, 2, 0L, 0L, 2));
        assertFalse(ring.offer(source, 0, 0, 0L, 0L, 0));
        assertFalse(ring.offer(source, 0, -2, 0L, 0L, 0));
        assertFalse(ring.offer(source, 3, 2, 0L, 0L, 2));
        assertFalse(ring.offer(source, 0, 5, 0L, 0L, 5));
        assertEquals(6L, ring.dropped());
        assertEquals(positionBefore, source.position());
        assertEquals(4, source.limit());
        assertFalse(ring.poll(chunk));

        assertTrue(ring.offer(source, 0, 4, 1L, 2L, 4));
        assertEquals(6L, ring.dropped());
        assertTrue(ring.poll(chunk));
        assertEquals(0x10, chunk.data[0]);
        assertEquals(6L, chunk.sequence);
    }

    @Test
    public void concurrentProducerAndConsumerPublishWholeChunksAndDrainAfterClose() throws Exception {
        PcmRing ring = new PcmRing(4, 8);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService threads = Executors.newFixedThreadPool(2);
        try {
            Future<?> producer = threads.submit(() -> {
                start.await();
                try {
                    for (int i = 0; i < 1000; i++) {
                        ByteBuffer source = frame(i, 8);
                        while (!ring.offer(source, 0, 8, i, i + 1L, 8)) {
                            if (Thread.currentThread().isInterrupted()) return null;
                            Thread.yield();
                        }
                    }
                } finally {
                    ring.close();
                }
                return null;
            });
            Future<?> consumer = threads.submit(() -> {
                start.await();
                PcmRing.Chunk chunk = new PcmRing.Chunk(8);
                int expected = 0;
                long previousSequence = -1;
                while (!ring.isDrained()) {
                    if (ring.poll(chunk)) {
                        assertEquals(8, chunk.size);
                        for (int j = 0; j < 8; j++) assertEquals((byte) (expected + j), chunk.data[j]);
                        assertEquals(expected, chunk.startNs);
                        assertEquals(expected + 1L, chunk.endNs);
                        assertEquals(8, chunk.written);
                        assertTrue(chunk.sequence > previousSequence);
                        previousSequence = chunk.sequence;
                        expected++;
                    } else {
                        if (Thread.currentThread().isInterrupted()) return null;
                        Thread.yield();
                    }
                }
                assertEquals(1000, expected);
                return null;
            });
            start.countDown();
            producer.get(5, TimeUnit.SECONDS);
            consumer.get(5, TimeUnit.SECONDS);
        } finally {
            threads.shutdownNow();
        }
    }

    private static byte[] copyOf(byte[] source, int size) {
        byte[] copy = new byte[size];
        System.arraycopy(source, 0, copy, 0, size);
        return copy;
    }
}
