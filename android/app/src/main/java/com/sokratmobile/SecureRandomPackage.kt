package com.sokratmobile

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class SecureRandomPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
        return if (name == SecureRandomModule.NAME) {
            SecureRandomModule(reactContext)
        } else {
            null
        }
    }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
        return ReactModuleInfoProvider {
            mapOf(
                SecureRandomModule.NAME to ReactModuleInfo(
                    SecureRandomModule.NAME,
                    SecureRandomModule::class.java.name,
                    false,
                    false,
                    false,
                    false
                )
            )
        }
    }
}
