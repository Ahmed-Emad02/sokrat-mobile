package com.sokratmobile

/** Pure native policy for provider ingress and native action replay. */
internal object IncomingPushPolicy {
    enum class Freshness { FRESH, STALE, INVALID }
    const val MAX_AGE_MS = 15_000L
    const val FUTURE_SKEW_MS = 5_000L

    fun extensionOwned(active: String?, payload: String?): Boolean {
        if (active == null) return true
        val expected = active.trim()
        val incoming = payload?.trim().orEmpty()
        return expected.isNotEmpty() && incoming.isNotEmpty() && expected == incoming
    }

    fun classify(
        now: Long,
        sentAt: Long?,
        maxAgeMs: Long = MAX_AGE_MS,
        futureSkewMs: Long = FUTURE_SKEW_MS,
    ): Freshness {
        if (sentAt == null || sentAt <= 0L) return Freshness.INVALID
        val age = now - sentAt
        return when {
            age > maxAgeMs -> Freshness.STALE
            age < -futureSkewMs -> Freshness.INVALID
            else -> Freshness.FRESH
        }
    }

    fun shouldMarkTerminal(freshness: Freshness, hasExistingRecord: Boolean): Boolean =
        freshness == Freshness.STALE && !hasExistingRecord

    fun isReplayable(action: String?): Boolean = action != null
}
