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
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the React Native process alive so the approved SIP registration and its
 * WebSocket stay connected while the app is in the background.
 *
 * The service starts as a signaling-only specialUse foreground service. During
 * an active call it is promoted to include the microphone type so Android can
 * continue allowing WebRTC capture after the call activity is backgrounded.
 * The service does not record audio itself, read call state, or bypass device
 * approval.
 */
class SokratConnectionService : Service() {

    @Volatile
    private var callAudioActive = false

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        startForegroundCompat(callAudioActive)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.hasExtra(EXTRA_CALL_AUDIO) == true) {
            callAudioActive = intent.getBooleanExtra(EXTRA_CALL_AUDIO, false)
        }
        startForegroundCompat(callAudioActive)
        return START_STICKY
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun applyCallAudioMode(active: Boolean) {
        callAudioActive = active
        startForegroundCompat(active)
    }

    private fun startForegroundCompat(callAudio: Boolean) {
        val notification = buildNotification(callAudio)
        try {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> {
                    var serviceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    if (callAudio) {
                        serviceType = serviceType or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                    }
                    startForeground(NOTIFICATION_ID, notification, serviceType)
                }
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && callAudio -> {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                    )
                }
                else -> startForeground(NOTIFICATION_ID, notification)
            }
        } catch (error: SecurityException) {
            // A denied RECORD_AUDIO or an OEM policy rejection must not crash
            // the call. Keep the signaling notification alive instead.
            Log.w(TAG, "call-audio foreground service rejected", error)
            callAudioActive = false
            startSignalingOnly(notification)
        } catch (error: IllegalArgumentException) {
            Log.w(TAG, "invalid call-audio foreground service type", error)
            callAudioActive = false
            startSignalingOnly(notification)
        }
    }

    private fun startSignalingOnly(notification: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (error: Exception) {
            Log.e(TAG, "signaling foreground service could not start", error)
        }
    }

    private fun buildNotification(callAudio: Boolean): Notification {
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
            .setContentText(if (callAudio) "Call in progress" else "Ready for incoming calls")
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
        private const val TAG = "SokratConnectionService"
        const val CHANNEL_ID = "sokrat_connection_v1"
        const val NOTIFICATION_ID = 2100
        const val EXTRA_CALL_AUDIO = "com.sokratmobile.extra.CALL_AUDIO"

        @Volatile
        private var instance: SokratConnectionService? = null

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, SokratConnectionService::class.java)
            )
        }

        fun setCallAudioActive(context: Context, active: Boolean) {
            val current = instance
            if (current != null) {
                current.applyCallAudioMode(active)
                return
            }
            if (!active) return
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, SokratConnectionService::class.java)
                        .putExtra(EXTRA_CALL_AUDIO, true)
                )
            } catch (error: Exception) {
                Log.w(TAG, "could not start call-audio foreground service", error)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SokratConnectionService::class.java))
        }
    }
}
