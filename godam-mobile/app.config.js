/**
 * Optional EXPO_PUBLIC_API_URL for dev tooling only. The app does not auto-connect:
 * users set Backend API Base URL once on the Configuration screen (stored in AsyncStorage).
 *
 * EAS cannot patch this file automatically; keep `extra.eas.projectId` in app.json when using EAS Build.
 */
const appJson = require('./app.json');

module.exports = {
  expo: {
    ...appJson.expo,
    extra: {
      ...(appJson.expo.extra || {}),
      apiUrl: process.env.EXPO_PUBLIC_API_URL || '',
    },
  },
};
