#if !__has_feature(cxx_abi_relative_vtable)
#error "The pinned WebRTC AAR requires the relative C++ vtable ABI"
#endif

#include <jni.h>
#include <cstdint>
#include <optional>
#include <type_traits>

#include "api/rtp_receiver_interface.h"

static_assert(std::is_same<absl::optional<double>, std::optional<double>>::value,
              "The pinned WebRTC ABI requires libc++ std::optional");

extern "C" JNIEXPORT void JNICALL
Java_org_webrtc_SokratNetEq_nativeSetMinimumDelay(JNIEnv* env, jclass, jlong handle) {
  if (handle == 0) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),
                  "Cannot configure a disposed WebRTC receiver");
    return;
  }
  // The package-private Java accessor returns RtpReceiverInterface*, not an
  // internal audio stream. Use its actual pinned header, never vtable offsets.
  auto* receiver = reinterpret_cast<webrtc::RtpReceiverInterface*>(
      static_cast<intptr_t>(handle));
  receiver->SetJitterBufferMinimumDelay(absl::optional<double>(0.300));
}
