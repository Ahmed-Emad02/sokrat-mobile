package com.sokratmobile

import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver

class SokratFirebaseMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        if (data["msg"] != "incoming-call") {
            forwardToReactNative(remoteMessage)
            return
        }

        val callId = data["callId"]
        if (!IncomingCallStore.isValidCallId(callId)) {
            Log.e(TAG, "[callId=${callId ?: "missing"}] rejected incoming push: invalid callId")
            return
        }

        val canonicalCallId = callId!!
        val callerId = data["callerId"] ?: "Unknown"
        val callerName = data["callerName"] ?: callerId
        val extension = data["extension"] ?: ""
        val timestamp = data["timestamp"]?.toLongOrNull() ?: System.currentTimeMillis()

        IncomingCallStore.upsertIncoming(
            applicationContext,
            canonicalCallId,
            callerId,
            callerName,
            extension,
            timestamp
        )
        Log.i(TAG, "[callId=$canonicalCallId] incoming push persisted")

        if (IncomingCallStore.claimNotification(applicationContext, canonicalCallId)) {
            IncomingCallNotificationHelper.showCallNotification(
                applicationContext,
                canonicalCallId,
                callerId,
                callerName,
                extension,
                timestamp.toString()
            )
            Log.i(TAG, "[callId=$canonicalCallId] native notification presented")
        }

        if (IncomingCallStore.claimBootstrap(applicationContext, canonicalCallId)) {
            forwardToReactNative(remoteMessage)
            Log.i(TAG, "[callId=$canonicalCallId] headless JS bootstrap forwarded")
        }
    }

    private fun forwardToReactNative(remoteMessage: RemoteMessage) {
        try {
            val intent = Intent(
                applicationContext,
                ReactNativeFirebaseMessagingReceiver::class.java
            ).apply {
                action = "com.google.android.c2dm.intent.RECEIVE"
                putExtras(remoteMessage.toIntent().extras ?: android.os.Bundle())
                setPackage(packageName)
            }
            sendBroadcast(intent)
        } catch (error: Exception) {
            Log.e(TAG, "headless JS bootstrap failed: ${error.message}", error)
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.i(TAG, "FCM token refreshed")
    }

    companion object {
        private const val TAG = "SokratPushService"
    }
}
