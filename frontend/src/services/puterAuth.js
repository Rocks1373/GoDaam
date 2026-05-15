import { loadPuter, formatPuterError, isPuterSignedIn } from './puterService';

export async function signIn() {
  const puter = await loadPuter();
  try {
    const result = await puter.auth.signIn();
    return result;
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function signOut() {
  const puter = await loadPuter();
  try {
    await puter.auth.signOut();
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export function isSignedIn() {
  return isPuterSignedIn();
}

export async function getUser() {
  const puter = await loadPuter();
  try {
    return await puter.auth.getUser();
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function ensureSignedIn() {
  if (isSignedIn()) return true;
  await signIn();
  return isSignedIn();
}
