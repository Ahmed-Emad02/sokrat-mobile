package com.sokratmobile

import org.junit.Assert.assertEquals
import org.junit.Test

class CallerDisplayNameTest {
    @Test
    fun usesNumberForPlaceholderAndMissingNames() {
        for (name in listOf("", "Unknown", " unknown caller ", "Incoming Call", "غير معروف")) {
            assertEquals("+44 20 1234 5678", CallerDisplayName.resolve("+44 20 1234 5678", name))
        }
        assertEquals("*43", CallerDisplayName.resolve("*43", "Unknown"))
        assertEquals("٢٠٤", CallerDisplayName.resolve("٢٠٤"))
        assertEquals("204", CallerDisplayName.resolve("sip:204@pbx.example", "Unknown"))
    }

    @Test
    fun keepsResolvedNamesButNeverInventsWithheldNumbers() {
        assertEquals("Colleague", CallerDisplayName.resolve("204", " Colleague "))
        for (number in listOf("", "anonymous", "restricted", "dongle0")) {
            assertEquals("Unknown", CallerDisplayName.resolve(number, "Unknown"))
        }
    }
}
