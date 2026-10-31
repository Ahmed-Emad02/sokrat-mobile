package com.sokratmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the React Native process alive so the approved SIP registration and its
 * WebSocket stay connected while the app is in the background.
 *
 * This is deliberately a low-importance, ongoing notification: Android does not
 * freeze an app with a foreground service, which is what makes locked-screen
 * incoming calls reliable on aggressive OEM builds (Honor/Huawei/Xiaomi/etc.).
 * The service does not record audio, read call state, or bypass device approval.
 */
class SokratConnectionService : Service() {

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForegroundCompat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startForegroundCompat() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(0xFFEB1235.toInt())
            .setContentTitle("Sokrat Mobile")
            .setContentText("Ready for incoming calls")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Call connection",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps Sokrat Mobile registered for incoming calls"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        manager.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_ID = "sokrat_connection_v1"
        const val NOTIFICATION_ID = 2100

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, SokratConnectionService::class.java)
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SokratConnectionService::class.java))
        }
    }
}
