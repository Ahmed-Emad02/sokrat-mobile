#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <Security/Security.h>

/**
 * Platform CSPRNG for enrollment claim secrets (iOS).
 *
 * Uses SecRandomCopyBytes (Apple's documented cryptographic RNG). The JS layer
 * fails closed when this module is absent, so there is no insecure fallback.
 */
@interface SecureRandomModule : NSObject <RCTBridgeModule>
@end

@implementation SecureRandomModule

RCT_EXPORT_MODULE(SokratSecureRandom)

RCT_EXPORT_METHOD(getRandomHex:(nonnull NSNumber *)bytes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSInteger length = [bytes integerValue];
  if (length <= 0 || length > 1024 || [bytes doubleValue] != (double)length) {
    reject(@"E_SECURE_RANDOM_LENGTH", @"Invalid byte length", nil);
    return;
  }

  uint8_t *buffer = malloc((size_t)length);
  if (buffer == NULL) {
    reject(@"E_SECURE_RANDOM", @"Unable to allocate entropy buffer", nil);
    return;
  }

  int status = SecRandomCopyBytes(kSecRandomDefault, (size_t)length, buffer);
  if (status != errSecSuccess) {
    free(buffer);
    reject(@"E_SECURE_RANDOM",
           [NSString stringWithFormat:@"SecRandomCopyBytes failed (%d)", status],
           nil);
    return;
  }

  NSMutableString *hex = [NSMutableString stringWithCapacity:(NSUInteger)(length * 2)];
  for (NSInteger i = 0; i < length; i++) {
    [hex appendFormat:@"%02x", buffer[i]];
  }
  free(buffer);
  resolve(hex);
}

@end
