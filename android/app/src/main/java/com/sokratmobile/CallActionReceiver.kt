package com.sokratmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != "com.sokratmobile.ACTION_DECLINE_CALL") return
        val callId = intent.getStringExtra("callId")
        if (!IncomingCallStore.isValidCallId(callId)) return

        val canonicalCallId = callId!!
        IncomingCallStore.setAction(context, canonicalCallId, "DECLINE")
        IncomingCallNotificationHelper.dismissCallNotification(context, canonicalCallId)
        CallNotificationModule.emitPersistedAction(context, canonicalCallId)

        val activityIntent = Intent(context, MainActivity::class.java).apply {
            action = "com.sokratmobile.ACTION_DECLINE_CALL"
            putExtras(intent.extras ?: android.os.Bundle())
            putExtra("callAction", "DECLINE")
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        }
        context.startActivity(activityIntent)
    }
}
