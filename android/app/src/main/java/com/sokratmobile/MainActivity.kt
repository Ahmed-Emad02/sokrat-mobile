package com.sokratmobile

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    currentActivity = java.lang.ref.WeakReference(this)
    volumeControlStream = android.media.AudioManager.STREAM_MUSIC
    applyIncomingCallWindow(intent)
    CallNotificationModule.onIntentReceived(applicationContext, intent)
  }

  override fun onResume() {
    super.onResume()
    val audioManager = getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
    if (audioManager?.mode == android.media.AudioManager.MODE_IN_COMMUNICATION) {
      volumeControlStream = android.media.AudioManager.STREAM_VOICE_CALL
    } else {
      volumeControlStream = android.media.AudioManager.STREAM_MUSIC
    }
  }
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    applyIncomingCallWindow(intent)
    CallNotificationModule.onIntentReceived(applicationContext, intent)
  }

  override fun onDestroy() {
    if (currentActivity?.get() === this) currentActivity = null
    super.onDestroy()
  }

  private fun applyIncomingCallWindow(intent: Intent?) {
    val action = intent?.getStringExtra("callAction")
    val incomingWindow = action == "SHOW" || action == "ANSWER"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(incomingWindow)
      setTurnScreenOn(incomingWindow)
    }
    if (incomingWindow) {
      window.addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      )
    } else {
      window.clearFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      )
    }
  }

  companion object {
    private var currentActivity: java.lang.ref.WeakReference<MainActivity>? = null

    fun clearIncomingCallWindow() {
      val activity = currentActivity?.get() ?: return
      activity.runOnUiThread { activity.applyIncomingCallWindow(null) }
    }
  }
  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "SokratMobile"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
