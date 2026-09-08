package com.sokratmobile

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class CallNotificationPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
        return if (name == CallNotificationModule.NAME) {
            CallNotificationModule(reactContext)
        } else {
            null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                CallNotificationModule.NAME to ReactModuleInfo(
                    CallNotificationModule.NAME,
                    CallNotificationModule::class.java.name,
                    false,
                    false,
                    false,
                    false
                )
            )
        }
    }
}
