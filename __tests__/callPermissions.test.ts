import { collectMissingCallPermissions } from '../src/calls/callPermissions';

test('returns null only when all calling surfaces are available', () => {
  expect(collectMissingCallPermissions({
    fullScreenAllowed: true,
    batteryOptimizationIgnored: true,
    notificationsAllowed: true,
  })).toBeNull();
});

test('marks a denied notification permission as the primary missing surface', () => {
  expect(collectMissingCallPermissions({
    fullScreenAllowed: true,
    batteryOptimizationIgnored: true,
    notificationsAllowed: false,
  })).toEqual({
    fullScreen: false,
    battery: false,
    notifications: true,
  });
});

test('reports all separate missing surfaces without conflating them', () => {
  expect(collectMissingCallPermissions({
    fullScreenAllowed: false,
    batteryOptimizationIgnored: false,
    notificationsAllowed: false,
  })).toEqual({
    fullScreen: true,
    battery: true,
    notifications: true,
  });
});
