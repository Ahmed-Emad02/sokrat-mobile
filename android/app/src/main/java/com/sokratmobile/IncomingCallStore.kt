package com.sokratmobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

object IncomingCallStore {
    private const val PREFS = "sokrat_incoming_calls"
    private const val KEY_RECORDS = "records"
    private const val KEY_TOMBSTONES = "tombstones"
    const val MAX_AGE_MS = 90_000L

    data class Record(
        val callId: String,
        val callerId: String,
        val callerName: String,
        val extension: String,
        val timestamp: Long,
        val action: String?,
        val terminalAt: Long?,
        val notificationShown: Boolean,
        val bootstrapForwarded: Boolean
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("callId", callId)
            put("callerId", callerId)
            put("callerName", callerName)
            put("extension", extension)
            put("timestamp", timestamp)
            if (action != null) put("action", action)
            if (terminalAt != null) put("terminalAt", terminalAt)
            put("notificationShown", notificationShown)
            put("bootstrapForwarded", bootstrapForwarded)
        }
    }

    fun isValidCallId(callId: String?): Boolean {
        if (callId.isNullOrBlank()) return false
        val trimmed = callId.trim()
        return trimmed.length in 3..128 && trimmed.all {
            it.isLetterOrDigit() || it == '-' || it == '_' || it == '.' || it == '@'
        }
    }

    @Synchronized
    fun upsertIncoming(
        context: Context,
        callId: String,
        callerId: String,
        callerName: String,
        extension: String,
        timestamp: Long
    ): Record {
        require(isValidCallId(callId)) { "Invalid callId" }
        val records = readRecords(context)
        val previous = records[callId]
        val record = Record(
            callId = callId,
            callerId = callerId,
            callerName = callerName,
            extension = extension,
            timestamp = timestamp,
            action = previous?.action,
            terminalAt = previous?.terminalAt,
            notificationShown = previous?.notificationShown ?: false,
            bootstrapForwarded = previous?.bootstrapForwarded ?: false
        )
        records[callId] = record
        writeRecords(context, records)
        return record
    }

    @Synchronized
    fun claimNotification(context: Context, callId: String): Boolean {
        val records = readRecords(context)
        val record = records[callId] ?: return false
        if (record.notificationShown) return false
        records[callId] = record.copy(notificationShown = true)
        writeRecords(context, records)
        return true
    }

    @Synchronized
    fun claimBootstrap(context: Context, callId: String): Boolean {
        val records = readRecords(context)
        val record = records[callId] ?: return false
        if (record.bootstrapForwarded) return false
        records[callId] = record.copy(bootstrapForwarded = true)
        writeRecords(context, records)
        return true
    }

    @Synchronized
    fun isTerminated(context: Context, callId: String): Boolean {
        if (!isValidCallId(callId)) return false
        val now = System.currentTimeMillis()
        val tombstones = readTombstones(context)
        val terminalAt = tombstones[callId] ?: return false
        if (now - terminalAt > MAX_AGE_MS) {
            tombstones.remove(callId)
            writeTombstones(context, tombstones)
            return false
        }
        return true
    }

    @Synchronized
    fun setAction(context: Context, callId: String, action: String): Record? {
        if (action != "ANSWER" && action != "DECLINE" && action != "END" && action != "SHOW") return null
        val records = readRecords(context)
        val record = records[callId] ?: return null
        // Terminal actions are first-writer-wins. A late SHOW or a second
        // Answer/Decline from a notification must never resurrect the call.
        if (isTerminated(context, callId) || record.terminalAt != null) return record
        if (action == "SHOW" && (record.action == "ANSWER" || record.action == "DECLINE" || record.action == "END")) return record
        val terminal = action == "ANSWER" || action == "DECLINE" || action == "END"
        val now = System.currentTimeMillis()
        val updated = record.copy(
            action = action,
            terminalAt = if (terminal) now else record.terminalAt
        )
        records[callId] = updated
        writeRecords(context, records)
        if (terminal) markTerminal(context, callId, now)
        return updated
    }

    @Synchronized
    private fun markTerminal(context: Context, callId: String, at: Long = System.currentTimeMillis()) {
        val tombstones = readTombstones(context)
        tombstones[callId] = at
        writeTombstones(context, tombstones)
    }

    @Synchronized
    fun acknowledgeAction(context: Context, callId: String, action: String) {
        val records = readRecords(context)
        val record = records[callId] ?: return
        if (record.action != action) return
        records[callId] = record.copy(action = null)
        writeRecords(context, records)
    }

    @Synchronized
    fun remove(context: Context, callId: String) {
        val records = readRecords(context)
        markTerminal(context, callId)
        if (records.remove(callId) != null) writeRecords(context, records)
    }

    @Synchronized
    fun pending(context: Context): List<Record> {
        val records = readRecords(context)
        writeRecords(context, records)
        return records.values.sortedBy { it.timestamp }
    }

    private fun readRecords(context: Context): MutableMap<String, Record> {
        val encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_RECORDS, null)
            ?: return mutableMapOf()
        val now = System.currentTimeMillis()
        return try {
            val objectValue = JSONObject(encoded)
            val records = mutableMapOf<String, Record>()
            val keys = objectValue.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = objectValue.optJSONObject(key) ?: continue
                val timestamp = value.optLong("timestamp", 0L)
                if (!isValidCallId(key) || timestamp <= 0L || now - timestamp > MAX_AGE_MS) continue
                records[key] = Record(
                    callId = key,
                    callerId = value.optString("callerId", "Unknown"),
                    callerName = value.optString("callerName", "Incoming Call"),
                    extension = value.optString("extension", ""),
                    timestamp = timestamp,
                    action = value.optString("action").takeIf { it.isNotBlank() },
                    terminalAt = value.optLong("terminalAt", 0L).takeIf { it > 0L },
                    notificationShown = value.optBoolean("notificationShown", false),
                    bootstrapForwarded = value.optBoolean("bootstrapForwarded", false)
                )
            }
            records
        } catch (_: Exception) {
            mutableMapOf()
        }
    }

    private fun readTombstones(context: Context): MutableMap<String, Long> {
        val encoded = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_TOMBSTONES, null) ?: return mutableMapOf()
        val now = System.currentTimeMillis()
        return try {
            val objectValue = JSONObject(encoded)
            val tombstones = mutableMapOf<String, Long>()
            val keys = objectValue.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val at = objectValue.optLong(key, 0L)
                if (isValidCallId(key) && at > 0L && now - at <= MAX_AGE_MS) {
                    tombstones[key] = at
                }
            }
            tombstones
        } catch (_: Exception) {
            mutableMapOf()
        }
    }

    private fun writeTombstones(context: Context, tombstones: Map<String, Long>) {
        val objectValue = JSONObject()
        tombstones.forEach { (callId, at) -> objectValue.put(callId, at) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TOMBSTONES, objectValue.toString())
            .apply()
    }

    private fun writeRecords(context: Context, records: Map<String, Record>) {
        val objectValue = JSONObject()
        records.forEach { (callId, record) -> objectValue.put(callId, record.toJson()) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_RECORDS, objectValue.toString())
            .apply()
    }
}
