const PUTER_SCRIPT_SRC = 'https://js.puter.com/v2/';

let loadPromise = null;

export function loadPuter() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Browser only'));
  if (window.puter) return Promise.resolve(window.puter);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${PUTER_SCRIPT_SRC}"]`);
    const script = existing || document.createElement('script');

    const done = () => {
      if (window.puter) resolve(window.puter);
      else reject(new Error('Puter.js loaded but global puter object is missing'));
    };

    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load Puter.js from CDN')), { once: true });

    if (!existing) {
      script.src = PUTER_SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    } else if (window.puter) {
      resolve(window.puter);
    }
  });

  return loadPromise;
}

export function getPuter() {
  return window.puter || null;
}

export function isPuterAvailable() {
  return Boolean(window.puter?.ai);
}

export function isPuterSignedIn() {
  try {
    return Boolean(window.puter?.auth?.isSignedIn());
  } catch {
    return false;
  }
}

export function formatPuterError(e) {
  const msg = String(e?.message || e || 'Puter request failed');
  if (/fetch failed|websocket|socket|500|drivers\/call|failed to load/i.test(msg)) {
    return 'Puter cloud service is not reachable. Check internet and allow api.puter.com / js.puter.com.';
  }
  if (/not configured/i.test(msg)) {
    return 'Puter service is not configured for this feature. Try a different provider or model.';
  }
  if (/sign.?in|auth|unauthorized/i.test(msg)) {
    return 'Puter authentication required. Please sign in to your Puter account.';
  }
  return msg;
}
