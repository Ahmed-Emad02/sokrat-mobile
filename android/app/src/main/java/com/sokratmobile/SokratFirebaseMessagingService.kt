package com.sokratmobile

import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver
import java.util.UUID

class SokratFirebaseMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        val msgType = data["msg"]

        Log.d(TAG, "[SokratPush] FCM onMessageReceived: msg=$msgType, data=$data")

        if (msgType == "incoming-call") {
            val callerId = data["callerId"] ?: "Unknown"
            val callerName = data["callerName"] ?: callerId
            val callId = data["callId"] ?: UUID.randomUUID().toString()
            val extension = data["extension"] ?: "150"
            val timestamp = data["timestamp"] ?: System.currentTimeMillis().toString()

            // 1. Immediately present Native High-Priority Full-Screen Notification
            IncomingCallNotificationHelper.showCallNotification(
                applicationContext,
                callId,
                callerId,
                callerName,
                extension,
                timestamp
            )
        }

        // 2. Forward to React Native Firebase Messaging receiver for JS Headless handling
        try {
            val intent = Intent(applicationContext, ReactNativeFirebaseMessagingReceiver::class.java).apply {
                action = "com.google.android.c2dm.intent.RECEIVE"
                putExtras(remoteMessage.toIntent().extras ?: android.os.Bundle())
            }
            sendBroadcast(intent)
        } catch (e: Exception) {
            Log.w(TAG, "[SokratPush] Failed to forward message to RN receiver: ${e.message}")
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d(TAG, "[SokratPush] FCM onNewToken: $token")
    }

    companion object {
        private const val TAG = "SokratPushService"
    }
}
