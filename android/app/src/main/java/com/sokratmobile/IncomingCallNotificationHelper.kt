package com.sokratmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object IncomingCallNotificationHelper {
    const val CHANNEL_ID = "sokrat_incoming_calls"
    const val CHANNEL_NAME = "Incoming Calls"
    private const val NOTIFICATION_ID_BASE = 2000
    private var screenWakeLock: android.os.PowerManager.WakeLock? = null

    @Synchronized
    private fun acquireScreenWakeLock(context: Context) {
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager ?: return
            if (screenWakeLock?.isHeld == true) {
                screenWakeLock?.release()
            }
            @Suppress("DEPRECATION")
            screenWakeLock = pm.newWakeLock(
                android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                    android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP or
                    android.os.PowerManager.ON_AFTER_RELEASE,
                "sokrat:incoming_call_screen_wake"
            ).apply {
                setReferenceCounted(false)
                acquire(25_000)
            }
        } catch (error: Exception) {
            error.printStackTrace()
        }
    }

    @Synchronized
    private fun releaseScreenWakeLock() {
        try {
            if (screenWakeLock?.isHeld == true) {
                screenWakeLock?.release()
            }
            screenWakeLock = null
        } catch (error: Exception) {
            error.printStackTrace()
        }
    }
    fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val audioAttributes = AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .build()
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Sokrat VOICE incoming call alerts"
            setSound(ringtoneUri, audioAttributes)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 1000, 1000, 1000, 1000, 1000)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setShowBadge(true)
            enableLights(true)
        }
        manager.createNotificationChannel(channel)
    }

    fun showCallNotification(
        context: Context,
        callId: String,
        callerId: String,
        callerName: String,
        extension: String,
        timestamp: String
    ) {
        acquireScreenWakeLock(context)
        createNotificationChannel(context)
        val title = callerName.ifBlank { callerId.ifBlank { "Incoming Call" } }
        val subtitle = if (callerId.isNotBlank() && callerId != callerName) {
            "Incoming call from $callerId"
        } else {
            "Incoming Sokrat VOICE call"
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

        fun activityIntent(action: String, callAction: String) =
            Intent(context, MainActivity::class.java).apply {
                this.action = action
                putCallExtras(this, callId, callerId, callerName, extension, timestamp)
                putExtra("callAction", callAction)
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP
                )
            }

        val showIntent = activityIntent(
            "com.sokratmobile.ACTION_INCOMING_CALL",
            "SHOW"
        )
        val showPendingIntent = PendingIntent.getActivity(
            context,
            requestCode(callId, 0),
            showIntent,
            flags
        )
        val answerPendingIntent = PendingIntent.getActivity(
            context,
            requestCode(callId, 1),
            activityIntent("com.sokratmobile.ACTION_ANSWER_CALL", "ANSWER"),
            flags
        )
        val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
            action = "com.sokratmobile.ACTION_DECLINE_CALL"
            putCallExtras(this, callId, callerId, callerName, extension, timestamp)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            context,
            requestCode(callId, 2),
            declineIntent,
            flags
        )

        val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(subtitle)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setSound(ringtoneUri)
            .setVibrate(longArrayOf(0, 1000, 1000, 1000, 1000, 1000))
            .setAutoCancel(false)
            .setOngoing(true)
            .setContentIntent(showPendingIntent)
            .setFullScreenIntent(showPendingIntent, true)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Decline",
                declinePendingIntent
            )
            .addAction(android.R.drawable.ic_menu_call, "Answer", answerPendingIntent)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(notificationId(callId), notification)
        } catch (error: SecurityException) {
            error.printStackTrace()
        }

        val pm = context.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
        if (pm?.isInteractive != true) {
            try {
                context.startActivity(showIntent)
            } catch (error: Exception) {
                // Full screen intent via notification handles launch if background start blocked
            }
        }
    }

    fun dismissCallNotification(context: Context, callId: String) {
        releaseScreenWakeLock()
        try {
            NotificationManagerCompat.from(context).cancel(notificationId(callId))
        } catch (error: Exception) {
            error.printStackTrace()
        }
    }

    private fun notificationId(callId: String): Int =
        NOTIFICATION_ID_BASE + (callId.hashCode() and 0x7fffffff) % 100_000

    private fun requestCode(callId: String, actionOffset: Int): Int =
        (callId.hashCode() and 0x7fffffff) + actionOffset

    private fun putCallExtras(
        intent: Intent,
        callId: String,
        callerId: String,
        callerName: String,
        extension: String,
        timestamp: String
    ) {
        intent.putExtra("callId", callId)
        intent.putExtra("callerId", callerId)
        intent.putExtra("callerName", callerName)
        intent.putExtra("extension", extension)
        intent.putExtra("timestamp", timestamp)
    }
}
