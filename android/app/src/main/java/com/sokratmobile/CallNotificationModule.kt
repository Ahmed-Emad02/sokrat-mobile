package com.sokratmobile

import android.content.Intent
import android.content.Context
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
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
import com.facebook.react.module.annotations.ReactModule
import kotlin.math.roundToInt
import android.media.AudioManager
import android.media.AudioDeviceInfo
import android.os.Build

@ReactModule(name = CallNotificationModule.NAME)
class CallNotificationModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    override fun initialize() {
        super.initialize()
        instance = this
    }

    override fun invalidate() {
        instance = null
        super.invalidate()
    }
    @ReactMethod
    fun setSpeakerphone(enable: Boolean, promise: Promise) {
        try {
            val audioManager = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            if (audioManager == null) {
                promise.reject("AUDIO_MANAGER_NULL", "AudioManager not available")
                return
            }

            if (audioManager.mode != AudioManager.MODE_IN_COMMUNICATION) {
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (enable) {
                    val speaker = audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    }
                    if (speaker != null) {
                        val success = audioManager.setCommunicationDevice(speaker)
                        android.util.Log.d("CallNotificationModule", "setCommunicationDevice(SPEAKER) result: $success")
                    } else {
                        audioManager.clearCommunicationDevice()
                    }
                } else {
                    val earpiece = audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    }
                    if (earpiece != null) {
                        val success = audioManager.setCommunicationDevice(earpiece)
                        android.util.Log.d("CallNotificationModule", "setCommunicationDevice(EARPIECE) result: $success")
                    } else {
                        audioManager.clearCommunicationDevice()
                    }
                }
            }

            audioManager.isSpeakerphoneOn = enable
            promise.resolve(enable)
        } catch (e: Exception) {
            android.util.Log.e("CallNotificationModule", "setSpeakerphone failed", e)
            promise.reject("SPEAKER_ERROR", e.message, e)
        }
    }
    @ReactMethod
    fun showIncomingCallNotification(
        callId: String,
        callerId: String,
        callerName: String,
        extension: String,
        timestamp: String
    ) {
        val canonicalCallId = if (IncomingCallStore.isValidCallId(callId)) callId else java.util.UUID.randomUUID().toString()
        IncomingCallStore.upsertIncoming(
            reactApplicationContext,
            canonicalCallId,
            callerId,
            callerName,
            extension,
            timestamp.toLongOrNull() ?: System.currentTimeMillis()
        )
        IncomingCallNotificationHelper.showCallNotification(
            reactApplicationContext,
            canonicalCallId,
            callerId,
            callerName,
            extension,
            timestamp
        )
    }

    @ReactMethod
    fun dismissCallNotification(callId: String) {
        IncomingCallNotificationHelper.dismissCallNotification(reactApplicationContext, callId)
        IncomingCallStore.remove(reactApplicationContext, callId)
    }
    @ReactMethod
    fun showOngoingCallNotification(callId: String, title: String, subtitle: String, startTimeMs: Double) {
        IncomingCallNotificationHelper.showOngoingCallNotification(
            reactApplicationContext,
            callId,
            title,
            subtitle,
            startTimeMs.toLong()
        )
    }

    @ReactMethod
    fun dismissOngoingCallNotification() {
        IncomingCallNotificationHelper.dismissOngoingCallNotification(reactApplicationContext)
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        val context = reactApplicationContext.currentActivity ?: reactApplicationContext
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val packageName = context.packageName
        if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
            try {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                promise.resolve(false)
            } catch (err: Exception) {
                promise.resolve(false)
            }
        } else {
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun isIgnoringBatteryOptimizations(promise: Promise) {
        val context = reactApplicationContext
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val isIgnoring = pm?.isIgnoringBatteryOptimizations(context.packageName) ?: false
        promise.resolve(isIgnoring)
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

    @ReactMethod
    fun setSpeakerVolume(percent: Double, promise: Promise) {
        try {
            val audioManager = reactApplicationContext.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
            val isInCall = audioManager.mode == android.media.AudioManager.MODE_IN_COMMUNICATION
            val stream = if (isInCall) android.media.AudioManager.STREAM_VOICE_CALL else android.media.AudioManager.STREAM_MUSIC
            val max = audioManager.getStreamMaxVolume(stream)
            val target = ((percent / 100.0) * max.toDouble()).roundToInt().coerceIn(1, max)

            // Set volume silently with 0 flags (no intrusive HUD popup and no audio beeps)
            audioManager.setStreamVolume(stream, target, 0)

            reactApplicationContext.currentActivity?.let { act ->
                act.runOnUiThread {
                    act.volumeControlStream = stream
                }
            }

            val curStep = target
            val maxStep = max
            val map = Arguments.createMap().apply {
                putInt("currentStep", curStep)
                putInt("maxStep", maxStep)
                putInt("percent", if (maxStep > 0) ((curStep.toDouble() / maxStep.toDouble()) * 100.0).roundToInt() else percent.toInt())
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("VOLUME_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getSpeakerVolume(promise: Promise) {
        try {
            val audioManager = reactApplicationContext.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
            val isInCall = audioManager.mode == android.media.AudioManager.MODE_IN_COMMUNICATION
            val streamType = if (isInCall) android.media.AudioManager.STREAM_VOICE_CALL else android.media.AudioManager.STREAM_MUSIC
            val maxVol = audioManager.getStreamMaxVolume(streamType)
            val current = audioManager.getStreamVolume(streamType)
            val pct = if (maxVol > 0) ((current.toDouble() / maxVol.toDouble()) * 100.0).roundToInt() else 80
            val map = Arguments.createMap().apply {
                putInt("currentStep", current)
                putInt("maxStep", maxVol)
                putInt("percent", pct)
            }
            promise.resolve(map)
        } catch (e: Exception) {
            val fallback = Arguments.createMap().apply {
                putInt("currentStep", 12)
                putInt("maxStep", 15)
                putInt("percent", 80)
            }
            promise.resolve(fallback)
        }
    }
    companion object {
        const val NAME = "CallNotificationModule"
        private var instance: CallNotificationModule? = null

        fun onIntentReceived(context: android.content.Context, intent: Intent?) {
            if (intent == null) return
            val callAction = intent.getStringExtra("callAction") ?: return
            val rawCallId = intent.getStringExtra("callId")
            val canonicalCallId = if (IncomingCallStore.isValidCallId(rawCallId)) {
                rawCallId!!
            } else {
                IncomingCallStore.pending(context).firstOrNull()?.callId ?: return
            }
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
