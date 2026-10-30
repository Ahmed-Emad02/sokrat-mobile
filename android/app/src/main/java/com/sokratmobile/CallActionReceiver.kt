package com.sokratmobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return
        if (intent.action == "com.sokratmobile.ACTION_SIMULATE_GSM") {
            val state = intent.getStringExtra("state") ?: "IDLE"
            CallNotificationModule.simulateGsmState(state)
            return
        }
        val ongoing = intent.action == "com.sokratmobile.ACTION_END_CALL"
        if (!ongoing && intent.action != "com.sokratmobile.ACTION_DECLINE_CALL") return
        val callId = intent.getStringExtra("callId")
        if (!IncomingCallStore.isValidCallId(callId)) return

        val canonicalCallId = callId!!
        val action = if (ongoing) "END" else "DECLINE"
        if (ongoing && IncomingCallStore.pending(context).none { it.callId == canonicalCallId }) {
            IncomingCallStore.upsertIncoming(context, canonicalCallId, "", "", "", System.currentTimeMillis())
        }
        IncomingCallStore.setAction(context, canonicalCallId, action)
        if (!ongoing) {
            IncomingCallNotificationHelper.dismissCallNotification(context, canonicalCallId)
        }
        CallNotificationModule.emitPersistedAction(context, canonicalCallId)
        val activityIntent = Intent(context, MainActivity::class.java).apply {
            this.action = intent.action
            putExtras(intent.extras ?: android.os.Bundle())
            putExtra("callAction", action)
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        }
        context.startActivity(activityIntent)
    }
}
