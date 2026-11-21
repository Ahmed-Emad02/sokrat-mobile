export type CallPermissionInput = {
  fullScreenAllowed: boolean;
  batteryOptimizationIgnored: boolean;
  notificationsAllowed: boolean;
};

export type MissingCallPermissions = {
  fullScreen: boolean;
  battery: boolean;
  notifications: boolean;
};

export function collectMissingCallPermissions(
  input: CallPermissionInput,
): MissingCallPermissions | null {
  const missing = {
    fullScreen: !input.fullScreenAllowed,
    battery: !input.batteryOptimizationIgnored,
    notifications: !input.notificationsAllowed,
  };
  return missing.fullScreen || missing.battery || missing.notifications ? missing : null;
}
