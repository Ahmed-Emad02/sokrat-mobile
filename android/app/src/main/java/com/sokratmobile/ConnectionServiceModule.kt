package com.sokratmobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class ConnectionServiceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    @ReactMethod
    fun start() {
        SokratConnectionService.start(reactApplicationContext)
    }

    @ReactMethod
    fun setCallAudioActive(active: Boolean) {
        SokratConnectionService.setCallAudioActive(reactApplicationContext, active)
    }

    @ReactMethod
    fun stop() {
        SokratConnectionService.stop(reactApplicationContext)
    }

    companion object {
        const val NAME = "SokratConnectionService"
    }
}
