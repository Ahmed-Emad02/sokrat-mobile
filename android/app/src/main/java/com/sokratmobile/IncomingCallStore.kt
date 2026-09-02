package com.sokratmobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

object IncomingCallStore {
    private const val PREFS = "sokrat_incoming_calls"
    private const val KEY_RECORDS = "records"
    private const val MAX_AGE_MS = 90_000L

    data class Record(
        val callId: String,
        val callerId: String,
        val callerName: String,
        val extension: String,
        val timestamp: Long,
        val action: String?,
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
            put("notificationShown", notificationShown)
            put("bootstrapForwarded", bootstrapForwarded)
        }
    }

    fun isValidCallId(callId: String?): Boolean {
        if (callId.isNullOrBlank()) return false
        return try {
            UUID.fromString(callId)
            true
        } catch (_: IllegalArgumentException) {
            false
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
    fun setAction(context: Context, callId: String, action: String): Record? {
        if (action != "ANSWER" && action != "DECLINE" && action != "SHOW") return null
        val records = readRecords(context)
        val record = records[callId] ?: return null
        val updated = record.copy(action = action)
        records[callId] = updated
        writeRecords(context, records)
        return updated
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
                    notificationShown = value.optBoolean("notificationShown", false),
                    bootstrapForwarded = value.optBoolean("bootstrapForwarded", false)
                )
            }
            records
        } catch (_: Exception) {
            mutableMapOf()
        }
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
