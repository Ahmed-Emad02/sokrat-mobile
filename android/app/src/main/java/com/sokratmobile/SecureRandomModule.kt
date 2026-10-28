package com.sokratmobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import java.security.SecureRandom

/**
 * Platform CSPRNG for enrollment claim secrets.
 *
 * Delegates to [java.security.SecureRandom], which Android seeds from the
 * kernel entropy pool. The JS layer fails closed when this module is missing,
 * so an insecure fallback is never used.
 */
@ReactModule(name = SecureRandomModule.NAME)
class SecureRandomModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    @ReactMethod
    fun getRandomHex(bytes: Double, promise: Promise) {
        try {
            val length = bytes.toInt()
            if (length <= 0 || length > MAX_BYTES || length.toDouble() != bytes) {
                promise.reject("E_SECURE_RANDOM_LENGTH", "Invalid byte length")
                return
            }
            val data = ByteArray(length)
            random.nextBytes(data)
            val hex = StringBuilder(length * 2)
            for (byte in data) {
                hex.append(String.format("%02x", byte.toInt() and 0xff))
            }
            promise.resolve(hex.toString())
        } catch (error: Throwable) {
            promise.reject("E_SECURE_RANDOM", error.message, error)
        }
    }

    companion object {
        const val NAME = "SokratSecureRandom"
        private const val MAX_BYTES = 1024
        private val random = SecureRandom()
    }
}
