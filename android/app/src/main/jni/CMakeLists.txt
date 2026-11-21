cmake_minimum_required(VERSION 3.22)
project(appmodules)

# Preserve React Native's generated application and autolinking setup.
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

add_library(sokrat_neteq SHARED ../cpp/neteq_minimum_delay.cpp)
target_include_directories(sokrat_neteq PRIVATE
    ../cpp/vendor/webrtc
    ../cpp/vendor/abseil-cpp)
# The language/Abseil configuration must match the pinned WebRTC AAR.
set_target_properties(sokrat_neteq PROPERTIES
    CXX_STANDARD 17 CXX_STANDARD_REQUIRED YES
    CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN YES)
target_compile_definitions(sokrat_neteq PRIVATE WEBRTC_ANDROID WEBRTC_POSIX)
# The shipped Chromium/WebRTC AAR uses 32-bit relative virtual tables.
# An ordinary NDK vtable call reads two offsets as one pointer and crashes.
target_compile_options(sokrat_neteq PRIVATE
    -fno-rtti -fno-exceptions -fexperimental-relative-c++-abi-vtables)
target_link_options(sokrat_neteq PRIVATE "-Wl,-z,max-page-size=16384")
