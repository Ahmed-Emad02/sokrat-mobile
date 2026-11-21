package com.sokratmobile

import org.junit.Assert.assertEquals
import org.junit.Test

class CallerDisplayNameTest {
    @Test
    fun doesNotUseNumberAsCallerNameForPlaceholdersOrMissingNames() {
        for (name in listOf("", "Unknown", " unknown caller ", "Incoming Call", "غير معروف")) {
            assertEquals("Unknown", CallerDisplayName.resolve("+44 20 1234 5678", name))
        }
        assertEquals("Unknown", CallerDisplayName.resolve("*43", "Unknown"))
        assertEquals("Unknown", CallerDisplayName.resolve("٢٠٤"))
        assertEquals("Unknown", CallerDisplayName.resolve("sip:204@pbx.example", "Unknown"))
    }

    @Test
    fun keepsResolvedNamesButNeverInventsWithheldNumbers() {
        assertEquals("Colleague", CallerDisplayName.resolve("204", " Colleague "))
        for (number in listOf("", "anonymous", "restricted", "dongle0")) {
            assertEquals("Unknown", CallerDisplayName.resolve(number, "Unknown"))
        }
    }
}
