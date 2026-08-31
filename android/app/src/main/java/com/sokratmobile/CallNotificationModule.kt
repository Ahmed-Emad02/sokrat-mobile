package com.sokratmobile

import android.content.Intent
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
    fun dismissCallNotification() {
        IncomingCallNotificationHelper.dismissCallNotification(reactApplicationContext)
    }

    @ReactMethod
    fun getInitialCallAction(promise: Promise) {
        val action = initialCallAction
        if (action != null) {
            val map = Arguments.createMap().apply {
                putString("action", action.action)
                putString("callId", action.callId)
                putString("callerId", action.callerId)
                putString("callerName", action.callerName)
                putString("extension", action.extension)
                putString("timestamp", action.timestamp)
            }
            initialCallAction = null
            promise.resolve(map)
        } else {
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required for React Native built-in EventEmitter calls
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required for React Native built-in EventEmitter calls
    }

    companion object {
        private var instance: CallNotificationModule? = null

        data class CallActionData(
            val action: String,
            val callId: String,
            val callerId: String,
            val callerName: String,
            val extension: String,
            val timestamp: String
        )

        var initialCallAction: CallActionData? = null

        fun onCallDeclined(callId: String) {
            val map = Arguments.createMap().apply {
                putString("action", "DECLINE")
                putString("callId", callId)
            }
            emitEvent("onCallAction", map)
        }

        fun onIntentReceived(intent: Intent?) {
            if (intent == null) return

            val callAction = intent.getStringExtra("callAction")
            val callId = intent.getStringExtra("callId") ?: ""
            val callerId = intent.getStringExtra("callerId") ?: ""
            val callerName = intent.getStringExtra("callerName") ?: ""
            val extension = intent.getStringExtra("extension") ?: ""
            val timestamp = intent.getStringExtra("timestamp") ?: ""

            if (!callAction.isNullOrEmpty()) {
                val data = CallActionData(
                    action = callAction,
                    callId = callId,
                    callerId = callerId,
                    callerName = callerName,
                    extension = extension,
                    timestamp = timestamp
                )

                if (instance != null) {
                    val map = Arguments.createMap().apply {
                        putString("action", callAction)
                        putString("callId", callId)
                        putString("callerId", callerId)
                        putString("callerName", callerName)
                        putString("extension", extension)
                        putString("timestamp", timestamp)
                    }
                    emitEvent("onCallAction", map)
                } else {
                    initialCallAction = data
                }
            }
        }

        private fun emitEvent(eventName: String, params: WritableMap) {
            instance?.reactApplicationContext
                ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit(eventName, params)
        }
    }
}
