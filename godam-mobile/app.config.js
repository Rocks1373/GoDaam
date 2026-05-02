/**
 * Production API default points at Hostinger VPS (same nginx origin as web).
 * Override locally with EXPO_PUBLIC_API_URL in .env
 */
const appJson = require('./app.json');

const DEFAULT_PUBLIC_API = 'http://72.61.245.23:8080';

module.exports = {
  expo: {
    ...appJson.expo,
    extra: {
      ...(appJson.expo.extra || {}),
      apiUrl: process.env.EXPO_PUBLIC_API_URL || DEFAULT_PUBLIC_API,
    },
  },
};
