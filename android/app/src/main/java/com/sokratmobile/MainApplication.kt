package com.sokratmobile

import android.app.Application
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
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
          add(SecureRandomPackage())
          add(ConnectionServicePackage())
          add(VpnPackage())
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
      val hwAec = AcousticEchoCanceler.isAvailable()
      val hwNs = NoiseSuppressor.isAvailable()
      Log.i(
        "MainApplication",
        "[Audio] Hardware AEC available=$hwAec NS available=$hwNs; requesting HW AEC/NS"
      )
      val adm = JavaAudioDeviceModule.builder(applicationContext)
        .setUseHardwareAcousticEchoCanceler(true)
        .setUseHardwareNoiseSuppressor(true)
        // Keep WebRTC on the deeper Java AudioTrack path. The low-latency
        // DIRECT/VOIP_RX track underran ~4.5 times/s on the test device.
        .setUseLowLatency(false)
        .setEnableVolumeLogger(false)
        .createAudioDeviceModule()
      WebRTCModuleOptions.getInstance().audioDeviceModule = adm
      Log.i("MainApplication", "[Audio] Configured hardware-preferred AEC/NS WebRTC ADM")
    } catch (e: Throwable) {
      Log.e("MainApplication", "[Audio] Failed to configure custom WebRTC ADM, falling back", e)
    }
  }
}
