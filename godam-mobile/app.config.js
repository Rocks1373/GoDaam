/** Expo config — API URL + Google OAuth client IDs from .env / baseline. */
const appJson = require('./app.json');
const { VPS_BASELINE_ORIGIN } = require('./baseline-api.js');

const apiOrigin =
  (process.env.EXPO_PUBLIC_API_URL && String(process.env.EXPO_PUBLIC_API_URL).trim()) ||
  VPS_BASELINE_ORIGIN;

module.exports = () => ({
  expo: {
    ...appJson.expo,
    scheme: 'godam',
    extra: {
      ...appJson.expo.extra,
      apiUrl: apiOrigin.replace(/\/+$/, ''),
      googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '',
      googleAndroidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || '',
    },
  },
});
