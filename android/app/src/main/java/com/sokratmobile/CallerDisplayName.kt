package com.sokratmobile

/** Same number-first fallback as JS; never trust a push/trunk display label. */
object CallerDisplayName {
    private val placeholders = Regex(
        "^(unknown(?: caller)?|incoming call|outgoing call|anonymous|unavailable|restricted|private(?: number)?|غير معروف|متصل غير معروف|مكالمة واردة)$",
        RegexOption.IGNORE_CASE
    )
    private val numberCharacters = Regex("^[+*#0-9\u0660-\u0669\u06f0-\u06f9\\s().-]+$")
    private val digit = Regex("[0-9\u0660-\u0669\u06f0-\u06f9]")
    private val routingName = Regex(
        "^(?:dongle|pjsip|sip|local|macro)(?:[\\/:\\s_-]|$)|^from-(?:internal|trunk)(?:[\\/:\\s_-]|$)|^trunk(?:[\\/:\\s_-]|$)",
        RegexOption.IGNORE_CASE
    )

    fun resolve(number: String, name: String = ""): String {
        val label = name.trim()
        if (label.isNotEmpty() && !placeholders.matches(label) && !routingName.containsMatchIn(label)) return label
        val address = number.trim().replace(Regex("^(?:sips?|tel):", RegexOption.IGNORE_CASE), "").substringBefore('@')
        return if (digit.containsMatchIn(address) && numberCharacters.matches(address)) address else "Unknown"
    }
}
