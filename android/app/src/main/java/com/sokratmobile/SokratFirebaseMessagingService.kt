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
        val activeExtension = IncomingCallStore.activeExtension(applicationContext)
        if (!IncomingPushPolicy.extensionOwned(activeExtension, data["extension"])) {
            Log.i(TAG, "[callId=$canonicalCallId] ignored push for another extension")
            return
        }
        if (IncomingCallStore.isTerminated(applicationContext, canonicalCallId)) {
            Log.i(TAG, "[callId=$canonicalCallId] ignored terminated incoming push")
            return
        }
        val now = System.currentTimeMillis()
        val sentAt = data["timestamp"]?.trim()?.toLongOrNull()
        val freshness = IncomingPushPolicy.classify(now, sentAt)
        val existing = IncomingCallStore.pending(applicationContext)
            .firstOrNull { it.callId == canonicalCallId }
        if (freshness != IncomingPushPolicy.Freshness.FRESH) {
            // A duplicate must never dismiss or terminalize a call that is
            // already live. Only a valid-but-too-old push with no live owner
            // gets a tombstone so later retries stay suppressed.
            if (IncomingPushPolicy.shouldMarkTerminal(freshness, existing != null)) {
                IncomingCallStore.markTerminal(applicationContext, canonicalCallId, now)
                IncomingCallNotificationHelper.dismissCallNotification(applicationContext, canonicalCallId)
            }
            Log.i(TAG, "[callId=$canonicalCallId] ignored stale incoming push")
            return
        }
        val callerId = data["callerId"] ?: "Unknown"
        // Prefer the phone's address book; provider/push labels are only a fallback.
        val deviceName = DeviceContactLookup.lookup(applicationContext, callerId)
        // Push-provided callerName is display metadata, not contact authority.
        val callerName = CallerDisplayName.resolve(callerId, deviceName)
        val extension = data["extension"] ?: ""
        val timestamp = existing?.timestamp ?: (sentAt ?: now)

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
