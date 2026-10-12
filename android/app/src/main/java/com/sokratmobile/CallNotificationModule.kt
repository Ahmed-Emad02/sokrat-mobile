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
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest

@ReactModule(name = CallNotificationModule.NAME)
class CallNotificationModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastEmittedConnected: Boolean? = null
    private var lastEmittedNetworkType: String? = null
    override fun initialize() {
        super.initialize()
        instance = this
        registerNetworkCallback()
    }

    override fun invalidate() {
        unregisterNetworkCallback()
        instance = null
        super.invalidate()
    }

    private fun registerNetworkCallback() {
        try {
            val cm = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    emitNetworkChange(true, getNetworkType(cm, network))
                }

                override fun onLost(network: Network) {
                    emitNetworkChange(false, "NONE")
                }

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    val hasInternet = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    emitNetworkChange(hasInternet, getNetworkTypeFromCapabilities(capabilities))
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                cm.registerDefaultNetworkCallback(networkCallback!!)
            } else {
                val request = NetworkRequest.Builder().build()
                cm.registerNetworkCallback(request, networkCallback!!)
            }
        } catch (e: Exception) {
            android.util.Log.e("CallNotificationModule", "registerNetworkCallback failed", e)
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            val cm = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            networkCallback?.let { cm.unregisterNetworkCallback(it) }
            networkCallback = null
        } catch (e: Exception) {
            android.util.Log.e("CallNotificationModule", "unregisterNetworkCallback failed", e)
        }
    }

    private fun getNetworkType(cm: ConnectivityManager, network: Network): String {
        val caps = cm.getNetworkCapabilities(network) ?: return "UNKNOWN"
        return getNetworkTypeFromCapabilities(caps)
    }

    private fun getNetworkTypeFromCapabilities(caps: NetworkCapabilities): String {
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ETHERNET"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "BLUETOOTH"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "VPN"
            else -> "OTHER"
        }
    }

    private fun emitNetworkChange(isConnected: Boolean, networkType: String) {
        if (isConnected == lastEmittedConnected && networkType == lastEmittedNetworkType) {
            return
        }
        lastEmittedConnected = isConnected
        lastEmittedNetworkType = networkType
        val params = Arguments.createMap().apply {
            putBoolean("isConnected", isConnected)
            putString("networkType", networkType)
        }
        emitEvent("onNetworkStateChanged", params)
    }

    @ReactMethod
    fun getNetworkState(promise: Promise) {
        try {
            val cm = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            if (cm == null) {
                val map = Arguments.createMap().apply {
                    putBoolean("isConnected", false)
                    putString("networkType", "NONE")
                }
                promise.resolve(map)
                return
            }
            val activeNetwork = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) cm.activeNetwork else null
            val caps = if (activeNetwork != null) cm.getNetworkCapabilities(activeNetwork) else null
            val isConnected = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            val networkType = if (caps != null) getNetworkTypeFromCapabilities(caps) else "NONE"
            val map = Arguments.createMap().apply {
                putBoolean("isConnected", isConnected)
                putString("networkType", networkType)
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("NETWORK_ERROR", e.message, e)
        }
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
    fun setAudioRoute(route: String, promise: Promise) {
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
                val targetDevice = when (route.uppercase()) {
                    "BLUETOOTH" -> audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                        it.type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                        it.type == AudioDeviceInfo.TYPE_HEARING_AID ||
                        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                    }
                    "SPEAKER_PHONE" -> audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    }
                    "EARPIECE" -> audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    }
                    "WIRED_HEADSET" -> audioManager.availableCommunicationDevices.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                        it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                        it.type == AudioDeviceInfo.TYPE_USB_HEADSET
                    }
                    else -> null
                }

                if (targetDevice != null) {
                    val success = audioManager.setCommunicationDevice(targetDevice)
                    android.util.Log.d("CallNotificationModule", "setCommunicationDevice($route, name=${targetDevice.productName}) result: $success")
                } else {
                    if (route.uppercase() == "EARPIECE") {
                        audioManager.clearCommunicationDevice()
                    }
                    android.util.Log.w("CallNotificationModule", "No device found for route: $route")
                }
            }

            audioManager.isSpeakerphoneOn = (route.uppercase() == "SPEAKER_PHONE")
            promise.resolve(route)
        } catch (e: Exception) {
            android.util.Log.e("CallNotificationModule", "setAudioRoute failed", e)
            promise.reject("AUDIO_ROUTE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getAvailableAudioRoutes(promise: Promise) {
        try {
            val audioManager = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            val list = com.facebook.react.bridge.Arguments.createArray()
            val map = com.facebook.react.bridge.Arguments.createMap()
            var currentSelected = "EARPIECE"

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && audioManager != null) {
                val commDevice = audioManager.communicationDevice
                val devices = audioManager.availableCommunicationDevices
                var hasBt = false
                for (dev in devices) {
                    val typeName = when (dev.type) {
                        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                        AudioDeviceInfo.TYPE_BLE_HEADSET,
                        AudioDeviceInfo.TYPE_HEARING_AID,
                        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> {
                            hasBt = true
                            "BLUETOOTH"
                        }
                        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "SPEAKER_PHONE"
                        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "EARPIECE"
                        AudioDeviceInfo.TYPE_WIRED_HEADSET,
                        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                        AudioDeviceInfo.TYPE_USB_HEADSET -> "WIRED_HEADSET"
                        else -> null
                    }
                    if (typeName != null) {
                        list.pushString(typeName)
                    }
                }
                if (commDevice != null) {
                    currentSelected = when (commDevice.type) {
                        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "SPEAKER_PHONE"
                        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                        AudioDeviceInfo.TYPE_BLE_HEADSET,
                        AudioDeviceInfo.TYPE_HEARING_AID,
                        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH"
                        AudioDeviceInfo.TYPE_WIRED_HEADSET,
                        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                        AudioDeviceInfo.TYPE_USB_HEADSET -> "WIRED_HEADSET"
                        else -> "EARPIECE"
                    }
                }
                map.putArray("availableDevices", list)
                map.putString("selectedDevice", currentSelected)
                map.putBoolean("hasBluetooth", hasBt)
            } else {
                list.pushString("EARPIECE")
                list.pushString("SPEAKER_PHONE")
                map.putArray("availableDevices", list)
                map.putString("selectedDevice", if (audioManager?.isSpeakerphoneOn == true) "SPEAKER_PHONE" else "EARPIECE")
                map.putBoolean("hasBluetooth", false)
            }
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("GET_ROUTES_ERROR", e.message, e)
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
