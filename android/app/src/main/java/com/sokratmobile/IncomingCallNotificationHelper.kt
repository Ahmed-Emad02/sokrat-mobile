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
import androidx.core.app.Person
import androidx.core.app.NotificationManagerCompat

object IncomingCallNotificationHelper {
    const val CHANNEL_ID = "sokrat_incoming_calls_v2"
    const val LEGACY_CHANNEL_ID = "sokrat_incoming_calls"
    const val CHANNEL_NAME = "Incoming Calls"
    const val ONGOING_CHANNEL_ID = "sokrat_active_call_v3"
    const val ONGOING_CHANNEL_NAME = "Active Call"
    const val MISSED_CHANNEL_ID = "sokrat_missed_calls_v1"
    const val MISSED_CHANNEL_NAME = "Missed Calls"
    private const val NOTIFICATION_ID_BASE = 2000
    private const val ONGOING_NOTIFICATION_ID = 2099
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

    fun createOngoingNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        try {
            manager.deleteNotificationChannel("sokrat_ongoing_calls")
        } catch (_: Exception) {}
        if (manager.getNotificationChannel(ONGOING_CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            ONGOING_CHANNEL_ID,
            ONGOING_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Sokrat VOICE active call indicator"
            setShowBadge(true)
            enableLights(false)
            enableVibration(false)
            setSound(null, null)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    fun createMissedNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return
        if (manager.getNotificationChannel(MISSED_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            MISSED_CHANNEL_ID,
            MISSED_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Missed Sokrat VOICE calls"
            enableVibration(true)
            setShowBadge(true)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    fun showMissedCallNotification(
        context: Context,
        callerId: String,
        callerName: String,
        extension: String,
        timestamp: Long
    ) {
        createMissedNotificationChannel(context)
        val openIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            (timestamp and 0x7fffffff).toInt(),
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val who = callerName.ifBlank { callerId.ifBlank { "Unknown" } }
        val notification = NotificationCompat.Builder(context, MISSED_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(0xFFEB1235.toInt())
            .setContentTitle("Missed call")
            .setContentText("$who · Ext $extension")
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setWhen(timestamp)
            .build()
        try {
            NotificationManagerCompat.from(context).notify((timestamp and 0x7fffffff).toInt(), notification)
        } catch (error: SecurityException) {
            error.printStackTrace()
        }
    }

    fun showOngoingCallNotification(
        context: Context,
        callId: String,
        title: String,
        subtitle: String,
        startTimeMs: Long
    ) {
        createOngoingNotificationChannel(context)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

        val openIntent = Intent(context, MainActivity::class.java).apply {
            action = "com.sokratmobile.ACTION_SHOW_CALL"
            putExtra("callId", callId)
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        }
        val openPendingIntent = PendingIntent.getActivity(
            context,
            requestCode(callId, 10),
            openIntent,
            flags
        )

        val hangupIntent = Intent(context, MainActivity::class.java).apply {
            action = "com.sokratmobile.ACTION_END_CALL"
            putExtra("callId", callId)
            putExtra("callAction", "END")
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        }
        val hangupPendingIntent = PendingIntent.getActivity(
            context,
            requestCode(callId, 11),
            hangupIntent,
            flags
        )

        val effectiveWhen = if (startTimeMs > 0) startTimeMs else System.currentTimeMillis()

        val notification = NotificationCompat.Builder(context, ONGOING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(0xFFEB1235.toInt())
            .setContentTitle(title.ifBlank { "Active Call" })
            .setContentText(subtitle.ifBlank { "Call in progress" })
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setUsesChronometer(true)
            .setWhen(effectiveWhen)
            .setShowWhen(true)
            .addAction(
                android.R.drawable.ic_menu_call,
                "Return to Call",
                openPendingIntent
            )
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "End Call",
                hangupPendingIntent
            )
            .build()

        try {
            NotificationManagerCompat.from(context).notify(ONGOING_NOTIFICATION_ID, notification)
        } catch (error: SecurityException) {
            error.printStackTrace()
        }
    }

    fun dismissOngoingCallNotification(context: Context) {
        try {
            val nm = NotificationManagerCompat.from(context)
            nm.cancel(ONGOING_NOTIFICATION_ID)
        } catch (error: Exception) {
            error.printStackTrace()
        }
    }

    fun showCallNotification(
        context: Context,
        callId: String,
        callerId: String,
        callerName: String,
        extension: String,
        timestamp: String,
        silentUpdate: Boolean = false
    ) {
        if (!silentUpdate) {
            acquireScreenWakeLock(context)
            createNotificationChannel(context)
        }
        // SIP/push may arrive with only a number. Resolve the address book here
        // so the first notification frame already has the contact name.
        val deviceName = DeviceContactLookup.lookup(context, callerId)
        val title = CallerDisplayName.resolve(callerId, deviceName.ifBlank { callerName })
        val subtitle = if (callerId.isNotBlank() && callerId != title) {
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
        // Decline must launch the activity directly. Sending a broadcast and
        // calling startActivity() from its receiver is a notification trampoline
        // and is blocked on Android 12+ when the app process is not running.
        val declinePendingIntent = PendingIntent.getActivity(
            context,
            requestCode(callId, 2),
            activityIntent("com.sokratmobile.ACTION_DECLINE_CALL", "DECLINE"),
            flags
        )

        val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(0xFFEB1235.toInt())
            .setContentTitle(title)
            .setContentText(subtitle)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(false)
            .setOngoing(true)
            .setTimeoutAfter(IncomingCallStore.MAX_AGE_MS)
            .setContentIntent(showPendingIntent)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val person = Person.Builder().setName(title).setImportant(true).build()
            builder.setStyle(
                NotificationCompat.CallStyle.forIncomingCall(
                    person,
                    declinePendingIntent,
                    answerPendingIntent
                )
            )
        } else {
            builder.addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Decline",
                declinePendingIntent
            ).addAction(android.R.drawable.ic_menu_call, "Answer", answerPendingIntent)
        }
        if (silentUpdate) {
            builder.setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setOnlyAlertOnce(true)
                .setSound(null)
                .setVibrate(null)
        } else {
            builder.setPriority(NotificationCompat.PRIORITY_MAX)
                .setSound(ringtoneUri)
                .setVibrate(longArrayOf(0, 1000, 1000, 1000, 1000, 1000))
            val fullScreenAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE ||
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
                    ?.canUseFullScreenIntent() != false
            if (fullScreenAllowed) {
                builder.setFullScreenIntent(showPendingIntent, true)
            }
        }
        val notification = builder.build()

        try {
            NotificationManagerCompat.from(context).notify(notificationId(callId), notification)
        } catch (error: SecurityException) {
            error.printStackTrace()
        }

        val pm = context.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
        if (!silentUpdate && pm?.isInteractive != true) {
            try {
                context.startActivity(showIntent)
            } catch (error: Exception) {
                // Full screen intent via notification handles launch if background start blocked
            }
        }
    }

    fun updateCallNotification(context: Context, callId: String, callerName: String) {
        val record = IncomingCallStore.pending(context).firstOrNull { it.callId == callId } ?: return
        if (record.action == "ANSWER" || record.action == "DECLINE" || record.action == "END") return
        IncomingCallStore.upsertIncoming(
            context,
            callId,
            record.callerId,
            callerName,
            record.extension,
            record.timestamp
        )
        showCallNotification(
            context,
            callId,
            record.callerId,
            callerName,
            record.extension,
            record.timestamp.toString(),
            silentUpdate = true
        )
    }

    fun dismissCallNotification(context: Context, callId: String) {
        releaseScreenWakeLock()
        try {
            val nm = NotificationManagerCompat.from(context)
            nm.cancel(notificationId(callId))
            IncomingCallStore.pending(context).forEach {
                nm.cancel(notificationId(it.callId))
            }
            val sysNm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && sysNm != null) {
                sysNm.activeNotifications?.forEach { sbn ->
                    if (sbn.notification.channelId == CHANNEL_ID ||
                        sbn.notification.channelId == LEGACY_CHANNEL_ID) {
                        sysNm.cancel(sbn.id)
                    }
                }
            }
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
