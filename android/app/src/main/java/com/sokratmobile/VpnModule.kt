package com.sokratmobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import com.wireguard.crypto.Key
import com.wireguard.crypto.KeyPair
import org.json.JSONObject
import java.io.BufferedReader
import java.io.StringReader
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Embedded WireGuard control plane.
 *
 * The device generates and stores its private key locally. Only the public key
 * is exposed to JS for gateway peer registration. The tunnel profile contains
 * no credentials beyond the server public key and private-network routes.
 */
class VpnModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    private val prefs = reactContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private var pendingPrepare: Promise? = null
    private var backend: GoBackend? = null
    private var tunnel: SokratTunnel? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName(): String = NAME

    @ReactMethod
    fun prepare(promise: Promise) {
        val intent = VpnService.prepare(reactContext)
        if (intent == null) {
            promise.resolve(true)
            return
        }
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.reject("VPN_NO_ACTIVITY", "VPN permission requires an active app window")
            return
        }
        if (pendingPrepare != null) {
            promise.reject("VPN_BUSY", "VPN permission request already in progress")
            return
        }
        pendingPrepare = promise
        try {
            activity.startActivityForResult(intent, REQUEST_VPN_PERMISSION)
        } catch (error: Throwable) {
            pendingPrepare = null
            promise.reject("VPN_PREPARE_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun getPublicKey(promise: Promise) {
        try {
            val pair = keyPair()
            val publicKey = pair.publicKey.toBase64()
            promise.resolve(publicKey)
        } catch (error: Throwable) {
            promise.reject("VPN_KEY_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun start(profileJson: String, promise: Promise) {
        Thread {
            try {
                val profile = JSONObject(profileJson)
                val privateKey = keyPair().privateKey
                val serverPublicKey = profile.getString("serverPublicKey")
                val address = profile.getString("address")
                val allowedIPs = profile.getJSONArray("allowedIPs")
                val endpoint = profile.getString("endpoint")
                val mtu = if (profile.has("mtu")) profile.getInt("mtu") else 1380
                val keepalive = if (profile.has("keepaliveSeconds")) profile.getInt("keepaliveSeconds") else 25
                val name = if (profile.has("name")) profile.getString("name") else TUNNEL_NAME
                require(name.length <= Tunnel.NAME_MAX_LENGTH) { "Tunnel name is too long" }
                if (address.isBlank() || allowedIPs.length() == 0 || endpoint.isBlank()) {
                    throw IllegalArgumentException("Incomplete WireGuard profile")
                }

                val allowed = (0 until allowedIPs.length()).joinToString(", ") { allowedIPs.getString(it) }
                val configText = buildString {
                    appendLine("[Interface]")
                    appendLine("PrivateKey = ${privateKey.toBase64()}")
                    appendLine("Address = $address")
                    appendLine("MTU = $mtu")
                    appendLine()
                    appendLine("[Peer]")
                    appendLine("PublicKey = $serverPublicKey")
                    appendLine("AllowedIPs = $allowed")
                    appendLine("Endpoint = $endpoint")
                    appendLine("PersistentKeepalive = $keepalive")
                }
                val config = Config.parse(BufferedReader(StringReader(configText)))
                prefs.edit().putString(PROFILE_KEY, profileJson).apply()

                try {
                    val vpnBackend = backend ?: GoBackend(reactContext).also { backend = it }
                    val target = tunnel ?: SokratTunnel(name).also { tunnel = it }
                    // GoBackend blocks while its VpnService starts; never run this
                    // on the Android main thread or service creation deadlocks.
                    vpnBackend.setState(target, Tunnel.State.UP, config)
                    Log.i(TAG, "WireGuard tunnel UP name=$name endpoint=$endpoint")
                    promise.resolve(true)
                } catch (error: Throwable) {
                    Log.e(TAG, "WireGuard tunnel start failed", error)
                    promise.reject("VPN_START_FAILED", error.message, error)
                }
            } catch (error: Throwable) {
                Log.e(TAG, "WireGuard profile/config failed", error)
                reactContext.runOnUiQueueThread { promise.reject("VPN_CONFIG_FAILED", error.message, error) }
            }
        }.start()
    }

    @ReactMethod
    fun stop(promise: Promise) {
        Thread {
            try {
                val vpnBackend = backend
                val target = tunnel
                if (vpnBackend != null && target != null) {
                    vpnBackend.setState(target, Tunnel.State.DOWN, null)
                }
                Log.i(TAG, "WireGuard tunnel DOWN")
                promise.resolve(true)
            } catch (error: Throwable) {
                Log.e(TAG, "WireGuard tunnel stop failed", error)
                promise.reject("VPN_STOP_FAILED", error.message, error)
            }
        }.start()
    }

    @ReactMethod
    fun status(promise: Promise) {
        try {
            val target = tunnel
            val state = if (target != null && backend?.getState(target) == Tunnel.State.UP) "UP" else "DOWN"
            promise.resolve(state)
        } catch (error: Throwable) {
            promise.reject("VPN_STATUS_FAILED", error.message, error)
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_VPN_PERMISSION) return
        val pending = pendingPrepare ?: return
        pendingPrepare = null
        if (resultCode == Activity.RESULT_OK) pending.resolve(true)
        else pending.reject("VPN_DENIED", "VPN permission was not granted")
    }

    override fun onNewIntent(intent: Intent) = Unit

    override fun invalidate() {
        pendingPrepare?.reject("VPN_MODULE_DESTROYED", "VPN module was destroyed")
        pendingPrepare = null
        reactContext.removeActivityEventListener(this)
        super.invalidate()
    }

    private fun keyPair(): KeyPair {
        val stored = decrypt(prefs.getString(PRIVATE_KEY, null))
        if (!stored.isNullOrBlank()) return KeyPair(Key.fromBase64(stored))
        val generated = KeyPair()
        prefs.edit().putString(PRIVATE_KEY, encrypt(generated.privateKey.toBase64())).apply()
        return generated
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val ciphertext = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val payload = ByteBuffer.allocate(4 + cipher.iv.size + ciphertext.size)
            .putInt(cipher.iv.size).put(cipher.iv).put(ciphertext).array()
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String?): String? {
        if (encoded.isNullOrBlank()) return null
        return try {
            val payload = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP))
            val ivLength = payload.int
            require(ivLength in 12..16) { "Invalid VPN key IV" }
            val iv = ByteArray(ivLength).also { payload.get(it) }
            val ciphertext = ByteArray(payload.remaining()).also { payload.get(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (error: Throwable) {
            Log.e(TAG, "Stored WireGuard key is unreadable; generating a new key", error)
            null
        }
    }

    private class SokratTunnel(private val tunnelName: String) : Tunnel {
        override fun getName(): String = tunnelName
        override fun onStateChange(newState: Tunnel.State) {
            Log.i(TAG, "WireGuard state changed: $newState")
        }
    }

    companion object {
        const val NAME = "SokratVpn"
        private const val TAG = "SokratVpn"
        private const val REQUEST_VPN_PERMISSION = 0x5356
        private const val PREFS = "sokrat_vpn"
        private const val PRIVATE_KEY = "private_key"
        private const val PROFILE_KEY = "profile"
        private const val KEY_ALIAS = "sokrat-vpn-wg-key"
        private const val TUNNEL_NAME = "sokratvpn"
    }
}
