import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Copy, FileText, Image, Paperclip, Trash2, X } from 'lucide-react';
import { aiAgentApi } from '../services/aiAgentApi';

const PUTER_SCRIPT_SRC = 'https://js.puter.com/v2/';
const PUTER_TEXT_MODEL = 'gpt-5.4-nano';
const PUTER_VISION_MODEL = 'gpt-5.4-nano';

let puterLoadPromise = null;

function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

function safeClipboard(text) {
  const t = String(text || '');
  if (!t) return Promise.resolve(false);
  if (navigator?.clipboard?.writeText) {
    return navigator.clipboard
      .writeText(t)
      .then(() => true)
      .catch(() => false);
  }
  return Promise.resolve(false);
}

function clampLines(text, max = 18) {
  const t = String(text || '');
  const lines = t.split('\n');
  if (lines.length <= max) return t;
  return `${lines.slice(0, max).join('\n')}\n…`;
}

function loadPuter() {
  if (typeof window === 'undefined') return Promise.reject(new Error('Puter is only available in the browser.'));
  if (window.puter?.ai) return Promise.resolve(window.puter);
  if (puterLoadPromise) return puterLoadPromise;
  puterLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${PUTER_SCRIPT_SRC}"]`);
    const script = existing || document.createElement('script');
    const done = () => {
      if (window.puter?.ai) resolve(window.puter);
      else reject(new Error('Puter.js loaded, but AI APIs are unavailable.'));
    };
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load Puter.js.')), { once: true });
    if (!existing) {
      script.src = PUTER_SCRIPT_SRC;
      script.async = true;
      document.head.appendChild(script);
    } else {
      setTimeout(done, 0);
    }
  });
  return puterLoadPromise;
}

function puterResponseText(response) {
  if (typeof response === 'string') return response;
  const content = response?.message?.content ?? response?.content ?? response?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || part?.content || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (response == null) return '';
  return JSON.stringify(response, null, 2);
}

function isSupportedVisualFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return (
    type.startsWith('image/') ||
    type === 'application/pdf' ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?|pdf)$/i.test(name)
  );
}

function readableAiError(e) {
  const msg = String(e?.message || e || 'AI request failed');
  if (/mistral/i.test(msg) && /not configured/i.test(msg)) {
    return 'Puter Mistral OCR is not configured. Trying Puter default OCR should avoid this.';
  }
  if (/fetch failed|websocket|socket|500|drivers\/call|failed to load/i.test(msg)) {
    return 'Puter cloud service is not reachable right now. Check internet access and allow api.puter.com / js.puter.com, then try again.';
  }
  return msg;
}

async function runPuterOcrRequest(puter, file) {
  try {
    return await puter.ai.img2txt(file);
  } catch (firstError) {
    const firstMessage = String(firstError?.message || firstError || '');
    if (/mistral/i.test(firstMessage) && /not configured/i.test(firstMessage)) {
      return puter.ai.img2txt({ source: file, provider: 'aws-textract' });
    }
    throw firstError;
  }
}

export default function FloatingAIAgent({ user }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [puterBusy, setPuterBusy] = useState(false);
  const [err, setErr] = useState('');
  const [input, setInput] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [messages, setMessages] = useState(() => [
    {
      id: `sys-${Date.now()}`,
      role: 'assistant',
      ts: nowIso(),
      text:
        "Hi — I'm the GoDam assistant. Ask me about outbound, FIFO, picking, delivery notes, stock rules, or errors.",
    },
  ]);

  const listRef = useRef(null);
  const fileInputRef = useRef(null);
  const lastSentRef = useRef('');

  const userRole = useMemo(() => user?.role || null, [user]);
  const canRunDiagnostics = useMemo(() => {
    const role = String(user?.role || '').toLowerCase().trim();
    if (role === 'admin' || role === 'head_admin' || role === 'head admin') return true;
    return Boolean(user?.permissions?.can_use_ai);
  }, [user]);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => {
      try {
        listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight, behavior: 'smooth' });
      } catch {
        // ignore
      }
    }, 50);
  }, [open, messages.length]);

  if (!user) return null;

  const clearChat = () => {
    setErr('');
    setInput('');
    setMessages([
      {
        id: `sys-${Date.now()}`,
        role: 'assistant',
        ts: nowIso(),
        text:
          "Chat cleared. Ask: “What is the correct outbound → FIFO → picking → delivery note process?”",
      },
    ]);
  };

  const send = async () => {
    const text = String(input || '').trim();
    if (!text) return;
    if (busy) return;
    if (text === lastSentRef.current) return;

    if (selectedFile) {
      await runPuterImageAnalysis();
      lastSentRef.current = '';
      return;
    }

    lastSentRef.current = text;

    const msgUser = { id: `u-${Date.now()}`, role: 'user', ts: nowIso(), text };
    setMessages((m) => [...m, msgUser]);
    setInput('');
    setErr('');
    setBusy(true);

    try {
      const pageContext = typeof window !== 'undefined' ? window.location?.pathname || '' : '';
      const out = await aiAgentApi.chat({
        message: text,
        pageContext,
        entityId: null,
        userRole,
      });

      let answer = String(out?.answer || '').trim();
      if (!answer && out?.raw) answer = clampLines(JSON.stringify(out.raw, null, 2));
      if (!answer) answer = 'No response.';

      const toolName = out?.raw?.tool_name ? String(out.raw.tool_name) : '';
      const toolHint =
        toolName && canRunDiagnostics
          ? `\n\n(Selected diagnostic/tool: ${toolName})`
          : toolName
            ? `\n\n(Selected tool: ${toolName})`
            : '';

      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text: `${answer}${toolHint}`,
        },
      ]);
    } catch (e) {
      try {
        const puter = await loadPuter();
        const response = await puter.ai.chat(
          [
            {
              role: 'system',
              content:
                'You are the GoDam warehouse assistant. Give short, practical answers for warehouse, SAP, logistics, stock, delivery, OCR, and troubleshooting questions. Do not claim you changed backend data.',
            },
            {
              role: 'user',
              content: text,
            },
          ],
          {
            model: PUTER_TEXT_MODEL,
          }
        );
        const answer = String(puterResponseText(response) || '').trim() || 'No response.';
        setMessages((m) => [
          ...m,
          {
            id: `aputer-${Date.now()}`,
            role: 'assistant',
            ts: nowIso(),
            text: `${answer}\n\n(Puter fallback: local AI plugin is not reachable.)`,
          },
        ]);
      } catch (puterError) {
        const backendMsg = e?.message || 'AI request failed';
        const puterMsg = puterError?.message || 'Puter fallback failed';
        setErr(`${backendMsg}. ${puterMsg}`);
        setMessages((m) => [
          ...m,
          {
            id: `aerr-${Date.now()}`,
            role: 'assistant',
            ts: nowIso(),
            text:
              'I could not reach the GoDam AI plugin or Puter AI right now. Check the AI plugin service and internet/Puter access.',
          },
        ]);
      }
    } finally {
      setBusy(false);
      setTimeout(() => {
        lastSentRef.current = '';
      }, 250);
    }
  };

  const onPickFile = (e) => {
    const file = e.target.files?.[0] || null;
    setErr('');
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!isSupportedVisualFile(file)) {
      setSelectedFile(null);
      setErr('Choose an image or PDF file for OCR/image analysis.');
      return;
    }
    setSelectedFile(file);
  };

  const runPuterOcr = async () => {
    if (!selectedFile || puterBusy) return;
    setErr('');
    setPuterBusy(true);
    const id = Date.now();
    setMessages((m) => [
      ...m,
      {
        id: `u-ocr-${id}`,
        role: 'user',
        ts: nowIso(),
        text: `OCR this file: ${selectedFile.name}`,
      },
    ]);
    try {
      const puter = await loadPuter();
      const response = await runPuterOcrRequest(puter, selectedFile);
      const text = String(puterResponseText(response) || '').trim() || 'No text detected.';
      setMessages((m) => [
        ...m,
        {
          id: `a-ocr-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text: `OCR result\n\n${text}`,
        },
      ]);
    } catch (e) {
      const msg = readableAiError(e);
      setErr(msg);
      setMessages((m) => [
        ...m,
        {
          id: `a-ocrerr-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text: `Puter OCR failed: ${msg}`,
        },
      ]);
    } finally {
      setPuterBusy(false);
    }
  };

  const runPuterImageAnalysis = async () => {
    if (!selectedFile || puterBusy) return;
    const prompt =
      String(input || '').trim() ||
      'Analyze this warehouse/logistics image. Extract visible text, identify document type, item numbers, quantities, dates, delivery/order references, risks, and suggested next action.';
    setErr('');
    setPuterBusy(true);
    const id = Date.now();
    setMessages((m) => [
      ...m,
      {
        id: `u-img-${id}`,
        role: 'user',
        ts: nowIso(),
        text: `Analyze image/file: ${selectedFile.name}\n\n${prompt}`,
      },
    ]);
    setInput('');
    try {
      const puter = await loadPuter();
      const response = await puter.ai.chat(prompt, selectedFile, {
        model: PUTER_VISION_MODEL,
      });
      const text = String(puterResponseText(response) || '').trim() || 'No analysis returned.';
      setMessages((m) => [
        ...m,
        {
          id: `a-img-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text: `Image analysis\n\n${text}`,
        },
      ]);
    } catch (e) {
      const msg = readableAiError(e);
      setErr(msg);
      setMessages((m) => [
        ...m,
        {
          id: `a-imgerr-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text: `Puter image analysis failed: ${msg}`,
        },
      ]);
    } finally {
      setPuterBusy(false);
    }
  };

  return (
    <div data-gapp-floating-ai className="gapp-floating-ai-root print:hidden">
      <div className="fixed bottom-4 right-4 z-[9999]">
        {!open ? (
          <button
            type="button"
            className="rounded-full shadow-lg bg-theme-primary text-white hover:opacity-95 w-12 h-12 flex items-center justify-center border border-theme-border"
            title="AI Assistant"
            onClick={() => setOpen(true)}
          >
            <Bot size={22} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="fixed bottom-4 right-4 z-[9999] w-[360px] max-w-[92vw] h-[520px] max-h-[75vh] rounded-xl border border-theme-border bg-theme-card shadow-2xl overflow-hidden flex flex-col">
          <div className="px-3 py-2 bg-theme-muted border-b border-theme-border flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-theme-primary text-white flex items-center justify-center flex-shrink-0">
                <Bot size={18} />
              </div>
              <div className="min-w-0">
                <div className="text-[12px] font-bold text-theme-fg truncate">GoDam AI Assistant</div>
                <div className="text-[10px] text-theme-fg-muted truncate">
                  {canRunDiagnostics ? 'Diagnostics enabled' : 'Process help mode'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                className="btn-secondary px-2 py-1"
                title="Clear chat"
                onClick={clearChat}
              >
                <Trash2 size={14} />
              </button>
              <button
                type="button"
                className="btn-secondary px-2 py-1"
                title="Close"
                onClick={() => setOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[88%] rounded-lg px-3 py-2 border text-[11px] whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-theme-primary text-white border-theme-border'
                      : 'bg-theme-card text-theme-fg border-theme-border'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">{m.text}</div>
                    {m.role === 'assistant' ? (
                      <button
                        type="button"
                        className="opacity-70 hover:opacity-100"
                        title="Copy"
                        onClick={() => safeClipboard(m.text)}
                      >
                        <Copy size={14} />
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="p-3 border-t border-theme-border bg-theme-card">
            {err ? <div className="mb-2 text-[10px] text-red-600 font-semibold">{err}</div> : null}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,.pdf,application/pdf"
              onChange={onPickFile}
            />
            <div className="mb-2 flex items-center gap-1.5 min-w-0">
              <button
                type="button"
                className="btn-secondary px-2 py-1 inline-flex items-center gap-1"
                title="Attach image or PDF"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || puterBusy}
              >
                <Paperclip size={13} />
                Attach
              </button>
              <button
                type="button"
                className="btn-secondary px-2 py-1 inline-flex items-center gap-1"
                title="Extract text with Puter OCR"
                onClick={runPuterOcr}
                disabled={busy || puterBusy || !selectedFile}
              >
                <FileText size={13} />
                OCR
              </button>
              <button
                type="button"
                className="btn-secondary px-2 py-1 inline-flex items-center gap-1"
                title="Analyze image with Puter AI"
                onClick={runPuterImageAnalysis}
                disabled={busy || puterBusy || !selectedFile}
              >
                <Image size={13} />
                Analyze
              </button>
              {selectedFile ? (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded-md border border-theme-border bg-theme-page px-2 py-1 text-left text-[10px] text-theme-fg-muted"
                  title={selectedFile.name}
                  onClick={() => setSelectedFile(null)}
                >
                  {puterBusy ? 'Puter working… ' : ''}
                  {selectedFile.name}
                </button>
              ) : null}
            </div>
            <div className="flex items-end gap-2">
              <textarea
                className="w-full rounded-lg border border-theme-border bg-theme-page text-theme-fg px-3 py-2 text-[11px] min-h-[44px] max-h-[110px] outline-none focus:ring-2 focus:ring-[var(--ring-primary)]"
                placeholder={
                  canRunDiagnostics
                    ? 'Ask: “Check GAPP delivery notification issue”'
                    : 'Ask: “What is the correct process for putaway?”'
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button
                type="button"
                className="btn-primary px-3 py-2"
                disabled={busy || puterBusy || !String(input || '').trim()}
                onClick={send}
                title="Send"
              >
                {busy ? '…' : 'Send'}
              </button>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-theme-fg-muted">
              <span>Enter = send · Shift+Enter = new line</span>
              <a
                className="font-semibold text-theme-primary hover:underline"
                href="https://developer.puter.com"
                target="_blank"
                rel="noreferrer"
              >
                Powered by Puter
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
