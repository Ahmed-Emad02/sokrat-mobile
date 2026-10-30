package com.sokratmobile

/** FCM call IDs must satisfy the same UUID contract as pushHandler.ts. */
internal object PushCallIdValidator {
    private val pattern = Regex(
        "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        RegexOption.IGNORE_CASE
    )

    fun isValid(callId: String?): Boolean = callId != null && pattern.matches(callId)
}
