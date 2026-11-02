package com.sokratmobile

import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingReceiver
import io.invertase.firebase.messaging.ReactNativeFirebaseMessagingService

class SokratFirebaseMessagingService : ReactNativeFirebaseMessagingService() {

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        if (data["msg"] == "cancel-call") {
            val callId = data["callId"]
            if (PushCallIdValidator.isValid(callId)) {
                Log.i(TAG, "[callId=$callId] cancel-call push received")
                IncomingCallNotificationHelper.dismissCallNotification(applicationContext, callId!!)
                IncomingCallStore.remove(applicationContext, callId)
            }
            forwardToReactNative(remoteMessage)
            return
        }
        if (data["msg"] != "incoming-call") {
            forwardToReactNative(remoteMessage)
            return
        }

        val callId = data["callId"]
        if (!PushCallIdValidator.isValid(callId)) {
            Log.e(TAG, "rejected incoming push: invalid callId")
            return
        }

        val canonicalCallId = callId!!
        val callerId = data["callerId"] ?: "Unknown"
        // Keep a human provider name; contact enrichment can improve it later.
        val callerName = CallerDisplayName.resolve(callerId, data["callerName"] ?: "")
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
        // Retain RNFirebase's token-refresh emitter; the custom manifest entry
        // replaces its service, so the Firebase base class alone drops this event.
        super.onNewToken(token)
        Log.i(TAG, "FCM token refreshed")
    }

    companion object {
        private const val TAG = "SokratPushService"
    }
}
