/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import TrackPlayer from '@rntp/player';

TrackPlayer.registerBackgroundEventHandler(() => async () => {
  // Transport controls are handled natively so they remain responsive in the car.
});

AppRegistry.registerComponent(appName, () => App);
