package com.sokratmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingPushPolicyTest {
    @Test
    fun acceptsOnlyTheBoundExtensionWhenOneIsPersisted() {
        assertTrue(IncomingPushPolicy.extensionOwned(null, "102"))
        assertFalse(IncomingPushPolicy.extensionOwned("", "102"))
        assertTrue(IncomingPushPolicy.extensionOwned("102", "102"))
        assertFalse(IncomingPushPolicy.extensionOwned("102", "202"))
        assertFalse(IncomingPushPolicy.extensionOwned("102", ""))
    }

    @Test
    fun classifiesFreshStaleAndInvalidTimestamps() {
        val now = 1_000_000L
        assertEquals(IncomingPushPolicy.Freshness.FRESH, IncomingPushPolicy.classify(now, now - 14_999))
        assertEquals(IncomingPushPolicy.Freshness.STALE, IncomingPushPolicy.classify(now, now - 15_001))
        assertEquals(IncomingPushPolicy.Freshness.INVALID, IncomingPushPolicy.classify(now, null))
        assertEquals(IncomingPushPolicy.Freshness.INVALID, IncomingPushPolicy.classify(now, now + 5_001))
    }

    @Test
    fun stalePushOnlyGetsTombstoneWhenNoLiveRecordExists() {
        assertFalse(IncomingPushPolicy.shouldMarkTerminal(IncomingPushPolicy.Freshness.STALE, true))
        assertTrue(IncomingPushPolicy.shouldMarkTerminal(IncomingPushPolicy.Freshness.STALE, false))
        assertFalse(IncomingPushPolicy.shouldMarkTerminal(IncomingPushPolicy.Freshness.INVALID, false))
        assertFalse(IncomingPushPolicy.shouldMarkTerminal(IncomingPushPolicy.Freshness.FRESH, false))
    }

    @Test
    fun nullActionIsNeverReplayable() {
        assertFalse(IncomingPushPolicy.isReplayable(null))
        assertTrue(IncomingPushPolicy.isReplayable("SHOW"))
        assertTrue(IncomingPushPolicy.isReplayable("END"))
    }
}
