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
    const val NOTIFICATION_ID = 2001

    fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return

            val existingChannel = notificationManager.getNotificationChannel(CHANNEL_ID)
            if (existingChannel != null) {
                return
            }

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

            notificationManager.createNotificationChannel(channel)
        }
    }

    fun showCallNotification(
        context: Context,
        callId: String,
        callerId: String,
        callerName: String,
        extension: String,
        timestamp: String
    ) {
        createNotificationChannel(context)

        val title = if (callerName.isNotBlank()) callerName else callerId.ifBlank { "Incoming Call" }
        val subtitle = if (callerId.isNotBlank() && callerId != callerName) {
            "Incoming call from $callerId"
        } else {
            "Incoming Sokrat VOICE call"
        }

        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

        // 1. Full Screen Intent (wakes up lock screen / launches incoming call UI)
        val fullScreenIntent = Intent(context, MainActivity::class.java).apply {
            action = "com.sokratmobile.ACTION_INCOMING_CALL"
            putExtra("callId", callId)
            putExtra("callerId", callerId)
            putExtra("callerName", callerName)
            putExtra("extension", extension)
            putExtra("timestamp", timestamp)
            putExtra("callAction", "SHOW")
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        }
        val fullScreenPendingIntent = PendingIntent.getActivity(
            context,
            callId.hashCode(),
            fullScreenIntent,
            flags
        )

        // 2. Answer Action Intent
        val answerIntent = Intent(context, MainActivity::class.java).apply {
            action = "com.sokratmobile.ACTION_ANSWER_CALL"
            putExtra("callId", callId)
            putExtra("callerId", callerId)
            putExtra("callerName", callerName)
            putExtra("extension", extension)
            putExtra("timestamp", timestamp)
            putExtra("callAction", "ANSWER")
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        }
        val answerPendingIntent = PendingIntent.getActivity(
            context,
            callId.hashCode() + 1,
            answerIntent,
            flags
        )

        // 3. Decline Action Intent (Broadcast to CallActionReceiver)
        val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
            action = "com.sokratmobile.ACTION_DECLINE_CALL"
            putExtra("callId", callId)
            putExtra("callerId", callerId)
            putExtra("callerName", callerName)
            putExtra("extension", extension)
            putExtra("timestamp", timestamp)
        }
        val declinePendingIntent = PendingIntent.getBroadcast(
            context,
            callId.hashCode() + 2,
            declineIntent,
            flags
        )

        val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
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
            .setContentIntent(fullScreenPendingIntent)
            .setFullScreenIntent(fullScreenPendingIntent, true)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", declinePendingIntent)
            .addAction(android.R.drawable.ic_menu_call, "Answer", answerPendingIntent)

        try {
            val notificationManager = NotificationManagerCompat.from(context)
            notificationManager.notify(NOTIFICATION_ID, builder.build())
        } catch (e: SecurityException) {
            // Android 13+ POST_NOTIFICATIONS check
            e.printStackTrace()
        }
    }

    fun dismissCallNotification(context: Context) {
        try {
            val notificationManager = NotificationManagerCompat.from(context)
            notificationManager.cancel(NOTIFICATION_ID)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
