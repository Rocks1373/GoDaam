/**
 * Optional EXPO_PUBLIC_API_URL for dev tooling only. The app does not auto-connect:
 * users set Backend API Base URL once on the Configuration screen (stored in AsyncStorage).
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
