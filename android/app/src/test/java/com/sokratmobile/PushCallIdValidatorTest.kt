package com.sokratmobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushCallIdValidatorTest {
    @Test
    fun acceptsCanonicalUuidVersionsAndVariantsInEitherCase() {
        for (version in '1'..'5') {
            for (variant in listOf('8', '9', 'a', 'b')) {
                val id = "abcdef12-3456-${version}abc-${variant}def-123456789abc"
                assertTrue(id, PushCallIdValidator.isValid(id))
                assertTrue(id.uppercase(), PushCallIdValidator.isValid(id.uppercase()))
            }
        }
    }

    @Test
    fun rejectsDiagnosticAndMalformedIds() {
        val invalid = listOf(
            null, "", "invalid-diagnostic-native-1029",
            "abcdef12-3456-0abc-8def-123456789abc",
            "abcdef12-3456-6abc-8def-123456789abc",
            "abcdef12-3456-4abc-7def-123456789abc",
            "abcdef12-3456-4abc-cdef-123456789abc",
            "abcdef12-3456-4abc-8def-123456789abg",
            "abcdef12-3456-4abc-8def-123456789ab",
            "abcdef1234564abc8def123456789abc",
            " abcdef12-3456-4abc-8def-123456789abc",
            "abcdef12-3456-4abc-8def-123456789abc\n",
            "urn:uuid:abcdef12-3456-4abc-8def-123456789abc"
        )
        invalid.forEach { assertFalse("accepted: $it", PushCallIdValidator.isValid(it)) }
    }
}
