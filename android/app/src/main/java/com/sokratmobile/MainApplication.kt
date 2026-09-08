package com.sokratmobile

import android.app.Application
import android.util.Log
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.oney.WebRTCModule.WebRTCModuleOptions
import org.webrtc.audio.JavaAudioDeviceModule

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(CallNotificationPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    IncomingCallNotificationHelper.createNotificationChannel(this)
    configureWebRtcAudio()
    loadReactNative(this)
  }

  private fun configureWebRtcAudio() {
    try {
      val adm = JavaAudioDeviceModule.builder(applicationContext)
        .setUseHardwareAcousticEchoCanceler(false)
        .setUseHardwareNoiseSuppressor(false)
        .setEnableVolumeLogger(false)
        .createAudioDeviceModule()
      WebRTCModuleOptions.getInstance().audioDeviceModule = adm
      Log.i("MainApplication", "[Audio] Configured software WebRTC AEC3 and Noise Suppression")
    } catch (e: Throwable) {
      Log.e("MainApplication", "[Audio] Failed to configure custom WebRTC ADM, falling back", e)
    }
  }
}
