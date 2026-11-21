package com.sokratmobile.diagnostics;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class CaptureAdmissionTest {
    @Test public void stopRejectsNewWritesButWaitsForAnAdmittedWrite() {
        CaptureAdmission gate = new CaptureAdmission();
        assertTrue(gate.enter());
        gate.close();
        assertFalse(gate.enter());
        assertEquals(1, gate.pending());
        assertFalse(gate.isDrained());
        gate.leave();
        assertEquals(0, gate.pending());
        assertTrue(gate.isDrained());
    }

    @Test public void allAdmittedCallbacksMustFinishBeforeDrainCompletes() {
        CaptureAdmission gate = new CaptureAdmission();
        assertTrue(gate.enter());
        assertTrue(gate.enter());
        gate.close();
        gate.leave();
        assertFalse(gate.isDrained());
        assertEquals(1, gate.pending());
        gate.leave();
        assertTrue(gate.isDrained());
    }

    @Test public void anExpiredCaptureWithNoAudioDrainsWithoutWaiting() {
        CaptureAdmission gate = new CaptureAdmission();
        gate.close();
        gate.close();
        assertFalse(gate.enter());
        assertEquals(0, gate.pending());
        assertTrue(gate.isDrained());
    }
}
