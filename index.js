/**
 * @format
 */

import './src/shims';
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
AppRegistry.registerHeadlessTask('RNCallKeepBackgroundMessage', () => async (data) => {
  console.log('[headless] RNCallKeepBackgroundMessage event:', data);
});
AppRegistry.registerComponent(appName, () => App);
