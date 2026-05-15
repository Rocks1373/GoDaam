import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

/**
 * Puter.js only runs in a browser context. This component embeds a minimal
 * HTML page that loads the Puter SDK and exposes AI/OCR/storage functions
 * via postMessage. The parent RN screen communicates through the ref handle.
 *
 * Usage:
 *   const ref = useRef<PuterBridgeHandle>(null);
 *   ref.current?.chat("What is FIFO?").then(answer => ...);
 *   ref.current?.ocr(base64ImageData).then(text => ...);
 */

export interface PuterBridgeHandle {
  chat: (prompt: string, systemPrompt?: string) => Promise<string>;
  ocr: (base64Data: string, mimeType?: string) => Promise<string>;
  signIn: () => Promise<boolean>;
  isReady: () => boolean;
}

interface Props {
  onReady?: () => void;
  onError?: (msg: string) => void;
}

const BRIDGE_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<script src="https://js.puter.com/v2/"></script>
</head>
<body>
<script>
  function extractText(r) {
    if (typeof r === 'string') return r;
    var c = r?.message?.content ?? r?.content ?? r?.text;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(function(p){return p?.text||p?.content||''}).filter(Boolean).join('\\n');
    return r == null ? '' : JSON.stringify(r);
  }

  function respond(id, ok, data) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ id: id, ok: ok, data: data }));
  }

  window.addEventListener('message', async function(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    var id = msg.id;
    try {
      if (msg.type === 'chat') {
        var messages = [
          { role: 'system', content: msg.systemPrompt || 'You are a warehouse assistant.' },
          { role: 'user', content: msg.prompt }
        ];
        var res = await puter.ai.chat(messages, { model: 'gpt-4o-mini' });
        respond(id, true, extractText(res));
      } else if (msg.type === 'ocr') {
        var blob = await fetch('data:' + (msg.mimeType || 'image/jpeg') + ';base64,' + msg.base64).then(function(r){return r.blob()});
        var file = new File([blob], 'scan.jpg', { type: msg.mimeType || 'image/jpeg' });
        var res = await puter.ai.img2txt(file);
        respond(id, true, extractText(res));
      } else if (msg.type === 'signIn') {
        await puter.auth.signIn();
        respond(id, true, 'signed_in');
      } else if (msg.type === 'ping') {
        respond(id, true, 'pong');
      }
    } catch (e) {
      respond(id, false, String(e?.message || e || 'Unknown error'));
    }
  });

  // Signal ready
  setTimeout(function() {
    window.ReactNativeWebView.postMessage(JSON.stringify({ id: '__ready__', ok: true, data: 'ready' }));
  }, 1500);
</script>
</body>
</html>
`;

const PuterWebViewBridge = forwardRef<PuterBridgeHandle, Props>(({ onReady, onError }, ref) => {
  const webViewRef = useRef<WebView>(null);
  const pendingRef = useRef<Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>>(new Map());
  const [ready, setReady] = useState(false);
  let nextId = useRef(0);

  const sendMessage = useCallback((type: string, payload: Record<string, unknown> = {}): Promise<string> => {
    return new Promise((resolve, reject) => {
      const id = `msg_${++nextId.current}`;
      pendingRef.current.set(id, { resolve, reject });
      const msg = JSON.stringify({ id, type, ...payload });
      webViewRef.current?.injectJavaScript(`window.postMessage(${JSON.stringify(msg)}, '*'); true;`);
      setTimeout(() => {
        if (pendingRef.current.has(id)) {
          pendingRef.current.delete(id);
          reject(new Error('Puter bridge timeout'));
        }
      }, 60000);
    });
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data) as { id: string; ok: boolean; data: string };
      if (msg.id === '__ready__') {
        setReady(true);
        onReady?.();
        return;
      }
      const pending = pendingRef.current.get(msg.id);
      if (!pending) return;
      pendingRef.current.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.data);
      } else {
        pending.reject(new Error(msg.data));
        onError?.(msg.data);
      }
    } catch {
      // ignore malformed messages
    }
  }, [onReady, onError]);

  useImperativeHandle(ref, () => ({
    chat: (prompt: string, systemPrompt?: string) =>
      sendMessage('chat', { prompt, systemPrompt }),
    ocr: (base64Data: string, mimeType?: string) =>
      sendMessage('ocr', { base64: base64Data, mimeType }),
    signIn: async () => {
      await sendMessage('signIn');
      return true;
    },
    isReady: () => ready,
  }), [sendMessage, ready]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html: BRIDGE_HTML }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={onMessage}
        style={styles.webview}
        onError={() => onError?.('WebView failed to load Puter bridge')}
      />
      {!ready && (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color="#0f766e" />
        </View>
      )}
    </View>
  );
});

PuterWebViewBridge.displayName = 'PuterWebViewBridge';

const styles = StyleSheet.create({
  container: { width: 0, height: 0, overflow: 'hidden', position: 'absolute', opacity: 0 },
  webview: { width: 1, height: 1 },
  loading: { position: 'absolute', top: 0, left: 0 },
});

export default PuterWebViewBridge;
