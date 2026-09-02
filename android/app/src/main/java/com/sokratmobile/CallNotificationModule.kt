package com.sokratmobile

import android.content.Intent
import android.Manifest
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class CallNotificationModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "CallNotificationModule"

    override fun initialize() {
        super.initialize()
        instance = this
    }

    override fun invalidate() {
        instance = null
        super.invalidate()
    }

    @ReactMethod
    fun dismissCallNotification(callId: String) {
        if (!IncomingCallStore.isValidCallId(callId)) return
        IncomingCallNotificationHelper.dismissCallNotification(reactApplicationContext, callId)
        IncomingCallStore.remove(reactApplicationContext, callId)
    }

    @ReactMethod
    fun clearCallWindow() {
        MainActivity.clearIncomingCallWindow()
    }

    @ReactMethod
    fun getPendingCalls(promise: Promise) {
        val calls = Arguments.createArray()
        IncomingCallStore.pending(reactApplicationContext).forEach { record ->
            calls.pushMap(record.toWritableMap())
        }
        promise.resolve(calls)
    }

    @ReactMethod
    fun acknowledgeAction(callId: String, action: String) {
        IncomingCallStore.acknowledgeAction(
            reactApplicationContext,
            callId,
            action.uppercase()
        )
    }

    @ReactMethod
    fun recordAction(callId: String, action: String) {
        IncomingCallStore.setAction(
            reactApplicationContext,
            callId,
            action.uppercase()
        )
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for React Native built-in EventEmitter calls.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for React Native built-in EventEmitter calls.
    }
    @ReactMethod
    fun getDeviceContacts(promise: Promise) {
        val context = reactApplicationContext
        val permission = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS)
        if (permission != PackageManager.PERMISSION_GRANTED) {
            promise.reject("PERMISSION_DENIED", "READ_CONTACTS permission not granted")
            return
        }

        try {
            val contactsList = Arguments.createArray()
            val seenNumbers = HashSet<String>()
            val contentResolver = context.contentResolver
            val uri = ContactsContract.CommonDataKinds.Phone.CONTENT_URI
            val projection = arrayOf(
                ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER
            )
            val sortOrder = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC"

            contentResolver.query(uri, projection, null, null, sortOrder)?.use { cursor ->
                val idIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
                val nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numberIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)

                while (cursor.moveToNext()) {
                    val id = if (idIndex >= 0) cursor.getString(idIndex) ?: "" else ""
                    val name = if (nameIndex >= 0) cursor.getString(nameIndex) ?: "Unknown" else "Unknown"
                    val rawNumber = if (numberIndex >= 0) cursor.getString(numberIndex) ?: "" else ""
                    val cleanNumber = rawNumber.replace(Regex("[^0-9+*#]"), "")

                    if (cleanNumber.isNotBlank() && !seenNumbers.contains(cleanNumber)) {
                        seenNumbers.add(cleanNumber)
                        val contactMap = Arguments.createMap().apply {
                            putString("id", "phone_${id}_${cleanNumber}")
                            putString("name", name)
                            putString("extension", cleanNumber)
                            putBoolean("favorite", false)
                        }
                        contactsList.pushMap(contactMap)
                    }
                }
            }
            promise.resolve(contactsList)
        } catch (e: Exception) {
            promise.reject("QUERY_ERROR", e.message, e)
        }
    }

    companion object {
        private var instance: CallNotificationModule? = null

        fun onIntentReceived(context: android.content.Context, intent: Intent?) {
            if (intent == null) return
            val callAction = intent.getStringExtra("callAction") ?: return
            val callId = intent.getStringExtra("callId")
            if (!IncomingCallStore.isValidCallId(callId)) return

            val canonicalCallId = callId!!
            val existing = IncomingCallStore.pending(context)
                .firstOrNull { it.callId == canonicalCallId }
            if (existing == null) {
                IncomingCallStore.upsertIncoming(
                    context,
                    canonicalCallId,
                    intent.getStringExtra("callerId") ?: "Unknown",
                    intent.getStringExtra("callerName") ?: "Incoming Call",
                    intent.getStringExtra("extension") ?: "",
                    intent.getStringExtra("timestamp")?.toLongOrNull()
                        ?: System.currentTimeMillis()
                )
            }
            IncomingCallStore.setAction(context, canonicalCallId, callAction)
            emitPersistedAction(context, canonicalCallId)
        }

        fun emitPersistedAction(context: android.content.Context, callId: String) {
            val record = IncomingCallStore.pending(context)
                .firstOrNull { it.callId == callId }
                ?: return
            emitEvent("onCallAction", record.toWritableMap())
        }

        private fun IncomingCallStore.Record.toWritableMap(): WritableMap =
            Arguments.createMap().apply {
                putString("action", action ?: "SHOW")
                putString("callId", callId)
                putString("callerId", callerId)
                putString("callerName", callerName)
                putString("extension", extension)
                putString("timestamp", timestamp.toString())
            }

        private fun emitEvent(eventName: String, params: WritableMap) {
            instance?.reactApplicationContext
                ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(eventName, params)
        }
    }
}
