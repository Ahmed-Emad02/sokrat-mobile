package com.sokratmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return

        val action = intent.action
        val callId = intent.getStringExtra("callId") ?: ""

        if (action == "com.sokratmobile.ACTION_DECLINE_CALL") {
            IncomingCallNotificationHelper.dismissCallNotification(context)
            CallNotificationModule.onCallDeclined(callId)
        }
    }
}
