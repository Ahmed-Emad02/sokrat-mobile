package com.sokratmobile

import android.bluetooth.BluetoothA2dp
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.Context
import android.content.IntentFilter
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
import android.view.WindowManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.telephony.TelephonyManager
import android.telephony.TelephonyCallback
import android.telephony.PhoneStateListener

@ReactModule(name = CallNotificationModule.NAME)
class CallNotificationModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastEmittedConnected: Boolean? = null
    private var lastEmittedNetworkType: String? = null
    private var telephonyCallback: Any? = null
    private var phoneStateListener: PhoneStateListener? = null
    private var lastGsmState: String = "IDLE"
    private var bluetoothReceiver: BroadcastReceiver? = null

    override fun initialize() {
        super.initialize()
        instance = this
        registerNetworkCallback()
        registerTelephonyListener()
        registerBluetoothReceiver()
    }

    override fun invalidate() {
        unregisterNetworkCallback()
        unregisterTelephonyListener()
        unregisterBluetoothReceiver()
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

    private fun registerTelephonyListener() {
        try {
            val tm = reactApplicationContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(state: Int) {
                        handleCallState(state)
                    }
                }
                telephonyCallback = cb
                val executor = ContextCompat.getMainExecutor(reactApplicationContext)
                tm.registerTelephonyCallback(executor, cb)
            } else {
                @Suppress("DEPRECATION")
                val listener = object : PhoneStateListener() {
                    @Deprecated("Deprecated in Java")
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        handleCallState(state)
                    }
                }
                phoneStateListener = listener
                @Suppress("DEPRECATION")
                tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
            }
        } catch (e: Exception) {
            android.util.Log.e("CallNotificationModule", "registerTelephonyListener failed", e)
        }
    }

    private fun unregisterTelephonyListener() {
        try {
            val tm = reactApplicationContext.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (telephonyCallback as? TelephonyCallback)?.let { tm.unregisterTelephonyCallback(it) }
                telephonyCallback = null
            } else {
                phoneStateListener?.let {
                    @Suppress("DEPRECATION")
                    tm.listen(it, PhoneStateListener.LISTEN_NONE)
                }
                phoneStateListener = null
            }
        } catch (e: Exception) {
            android.util.Log.e("CallNotificationModule", "unregisterTelephonyListener failed", e)
        }
    }

    private fun handleCallState(state: Int) {
        val stateStr = when (state) {
            TelephonyManager.CALL_STATE_RINGING -> "RINGING"
            TelephonyManager.CALL_STATE_OFFHOOK -> "OFFHOOK"
            else -> "IDLE"
        }
        if (stateStr == lastGsmState) return
        lastGsmState = stateStr
        val params = Arguments.createMap().apply {
            putString("state", stateStr)
        }
        emitEvent("onGsmCallStateChanged", params)
        android.util.Log.d("CallNotificationModule", "GSM call state changed: $stateStr")
    }

    @ReactMethod
    fun getGsmCallState(promise: Promise) {
        promise.resolve(lastGsmState)
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
                val btCommTypes = setOf(
                    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                    AudioDeviceInfo.TYPE_BLE_HEADSET,
                    AudioDeviceInfo.TYPE_HEARING_AID
                )
                if (route.uppercase() == "BLUETOOTH" &&
                    audioManager.availableCommunicationDevices.none { it.type in btCommTypes }) {
                    // The headset is paired and connected but the SCO link has
                    // not been started yet, so wake it before enumerating.
                    try {
                        @Suppress("DEPRECATION")
                        audioManager.startBluetoothSco()
                        @Suppress("DEPRECATION")
                        audioManager.isBluetoothScoOn = true
                    } catch (_: Exception) {
                    }
                }

                val routeCandidates = ArrayList<AudioDeviceInfo>()
                try {
                    routeCandidates.addAll(audioManager.availableCommunicationDevices)
                } catch (_: Exception) {
                }
                try {
                    audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).forEach { routeCandidates.add(it) }
                } catch (_: Exception) {
                }

                val targetDevice = when (route.uppercase()) {
                    "BLUETOOTH" -> routeCandidates.firstOrNull { it.type in btCommTypes }
                    "SPEAKER_PHONE" -> routeCandidates.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    }
                    "EARPIECE" -> routeCandidates.firstOrNull {
                        it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    }
                    "WIRED_HEADSET" -> routeCandidates.firstOrNull {
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

    private data class AudioRouteSnapshot(
        val devices: List<String>,
        val selected: String,
        val hasBluetooth: Boolean,
        val bluetoothName: String?
    )

    private fun mapAudioDeviceType(type: Int): String? = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_HEARING_AID,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "SPEAKER_PHONE"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "EARPIECE"
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        AudioDeviceInfo.TYPE_USB_HEADSET -> "WIRED_HEADSET"
        else -> null
    }

    @Suppress("DEPRECATION")
    private fun buildAudioRouteSnapshot(): AudioRouteSnapshot {
        val audioManager = reactApplicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val devices = LinkedHashSet<String>()
        var hasBluetooth = false
        var bluetoothName: String? = null
        var selected = "EARPIECE"

        fun note(dev: AudioDeviceInfo) {
            val mapped = mapAudioDeviceType(dev.type) ?: return
            devices.add(mapped)
            if (mapped == "BLUETOOTH") {
                hasBluetooth = true
                val name = dev.productName?.toString()?.trim()
                if (!name.isNullOrEmpty() && bluetoothName.isNullOrEmpty()) {
                    bluetoothName = name
                }
            }
        }

        if (audioManager != null) {
            // Connected output devices are visible even while the phone is idle
            // (A2DP headsets are not part of availableCommunicationDevices then).
            try {
                audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).forEach { note(it) }
            } catch (_: Exception) {
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                try {
                    audioManager.availableCommunicationDevices.forEach { note(it) }
                    audioManager.communicationDevice?.let {
                        selected = mapAudioDeviceType(it.type) ?: "EARPIECE"
                    }
                } catch (_: Exception) {
                }
            } else {
                selected = if (audioManager.isSpeakerphoneOn) "SPEAKER_PHONE" else "EARPIECE"
            }
            if (audioManager.isBluetoothScoOn) {
                selected = "BLUETOOTH"
            }
        }

        // The Bluetooth profiles remain connected even when the audio stack has
        // not exposed the headset as an output yet.
        try {
            val adapter = BluetoothAdapter.getDefaultAdapter()
            if (adapter != null && adapter.isEnabled) {
                val headset = adapter.getProfileConnectionState(BluetoothProfile.HEADSET)
                val a2dp = adapter.getProfileConnectionState(BluetoothProfile.A2DP)
                if (headset == BluetoothProfile.STATE_CONNECTED || a2dp == BluetoothProfile.STATE_CONNECTED) {
                    hasBluetooth = true
                    devices.add("BLUETOOTH")
                }
            }
        } catch (_: SecurityException) {
        } catch (_: Exception) {
        }

        devices.add("EARPIECE")
        devices.add("SPEAKER_PHONE")
        return AudioRouteSnapshot(devices.toList(), selected, hasBluetooth, bluetoothName)
    }

    private fun registerBluetoothReceiver() {
        if (bluetoothReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED,
                    BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED,
                    BluetoothDevice.ACTION_ACL_CONNECTED,
                    BluetoothDevice.ACTION_ACL_DISCONNECTED,
                    AudioManager.ACTION_HEADSET_PLUG,
                    AudioManager.ACTION_AUDIO_BECOMING_NOISY -> {
                        val snapshot = buildAudioRouteSnapshot()
                        emitEvent("onAudioDeviceChanged", Arguments.createMap().apply {
                            putString("availableAudioDeviceList", org.json.JSONArray(snapshot.devices).toString())
                            putString("selectedAudioDevice", snapshot.selected)
                            putBoolean("hasBluetooth", snapshot.hasBluetooth)
                            putString("bluetoothName", snapshot.bluetoothName ?: "")
                        })
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED)
            addAction(BluetoothA2dp.ACTION_CONNECTION_STATE_CHANGED)
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
            addAction(AudioManager.ACTION_HEADSET_PLUG)
            addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                reactApplicationContext.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                reactApplicationContext.registerReceiver(receiver, filter)
            }
            bluetoothReceiver = receiver
        } catch (e: Exception) {
            android.util.Log.w("CallNotificationModule", "Bluetooth receiver registration failed: ${e.message}")
        }
    }

    private fun unregisterBluetoothReceiver() {
        bluetoothReceiver?.let {
            try {
                reactApplicationContext.unregisterReceiver(it)
            } catch (_: Exception) {
            }
        }
        bluetoothReceiver = null
    }

    @ReactMethod
    fun setCallActive(active: Boolean, promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.resolve(false)
            return
        }
        activity.runOnUiThread {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    activity.setShowWhenLocked(active)
                    activity.setTurnScreenOn(active)
                }
                if (active) {
                    activity.window.addFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    )
                } else {
                    activity.window.clearFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    )
                }
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("CALL_WINDOW_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun getAvailableAudioRoutes(promise: Promise) {
        try {
            val snapshot = buildAudioRouteSnapshot()
            val list = com.facebook.react.bridge.Arguments.createArray()
            snapshot.devices.forEach { list.pushString(it) }
            val map = com.facebook.react.bridge.Arguments.createMap().apply {
                putArray("availableDevices", list)
                putString("selectedDevice", snapshot.selected)
                putBoolean("hasBluetooth", snapshot.hasBluetooth)
                putString("bluetoothName", snapshot.bluetoothName ?: "")
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

        fun simulateGsmState(state: String) {
            val params = Arguments.createMap().apply {
                putString("state", state)
            }
            emitEvent("onGsmCallStateChanged", params)
            android.util.Log.d("CallNotificationModule", "Simulated GSM state: $state")
        }

        private fun emitEvent(eventName: String, params: WritableMap) {
            instance?.reactApplicationContext
                ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(eventName, params)
        }
    }
}
