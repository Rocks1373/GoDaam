import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Copy, FileText, Paperclip, Trash2, X } from 'lucide-react';
import { aiAgentApi } from '../services/aiAgentApi';
import { ocrWithGoDam } from '../services/godamOcr';

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

function isSupportedVisualFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return (
    type.startsWith('image/') ||
    type === 'application/pdf' ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?|pdf)$/i.test(name)
  );
}

export default function FloatingAIAgent({ user }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
          'Chat cleared. Ask: “What is the correct outbound → FIFO → picking → delivery note process?”',
      },
    ]);
  };

  const askAssistant = async (text, { pageContext } = {}) => {
    const out = await aiAgentApi.chat({
      message: text,
      pageContext: pageContext ?? (typeof window !== 'undefined' ? window.location?.pathname || '' : ''),
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

    return `${answer}${toolHint}`;
  };

  const send = async () => {
    const text = String(input || '').trim();
    if (!text && !selectedFile) return;
    if (busy) return;
    if (!selectedFile && text === lastSentRef.current) return;

    lastSentRef.current = text || selectedFile?.name || '';

    const displayText =
      text || (selectedFile ? `Please analyze this file: ${selectedFile.name}` : '');
    const msgUser = { id: `u-${Date.now()}`, role: 'user', ts: nowIso(), text: displayText };
    setMessages((m) => [...m, msgUser]);
    setInput('');
    setErr('');
    setBusy(true);

    try {
      let messageForAi = text;
      if (selectedFile) {
        const ocrText = await ocrWithGoDam(selectedFile);
        const ocrBlock = ocrText
          ? `\n\n--- OCR from ${selectedFile.name} ---\n${ocrText}`
          : `\n\n--- OCR from ${selectedFile.name} ---\n(No text detected.)`;
        messageForAi = `${text || 'Summarize this document and list key warehouse fields (PO/SO/DN, items, quantities).'}${ocrBlock}`;
      }

      const answer = await askAssistant(messageForAi);
      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text: answer,
        },
      ]);
      if (selectedFile) setSelectedFile(null);
    } catch (e) {
      const backendMsg = e?.message || 'AI request failed';
      setErr(backendMsg);
      setMessages((m) => [
        ...m,
        {
          id: `aerr-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text:
            'I could not reach the GoDam AI service right now. Check that the AI plugin / ai-service is running and try again.',
        },
      ]);
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
      setErr('Choose an image or PDF file for OCR.');
      return;
    }
    setSelectedFile(file);
  };

  const runOcr = async () => {
    if (!selectedFile || busy) return;
    setErr('');
    setBusy(true);
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
      const text = (await ocrWithGoDam(selectedFile)) || 'No text detected.';
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
      const msg = e?.message || 'OCR failed';
      setErr(msg);
      setMessages((m) => [
        ...m,
        {
          id: `a-ocrerr-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text: `OCR failed: ${msg}`,
        },
      ]);
    } finally {
      setBusy(false);
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
                disabled={busy}
              >
                <Paperclip size={13} />
                Attach
              </button>
              <button
                type="button"
                className="btn-secondary px-2 py-1 inline-flex items-center gap-1"
                title="Extract text with GoDam OCR"
                onClick={runOcr}
                disabled={busy || !selectedFile}
              >
                <FileText size={13} />
                OCR
              </button>
              {selectedFile ? (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded-md border border-theme-border bg-theme-page px-2 py-1 text-left text-[10px] text-theme-fg-muted"
                  title={selectedFile.name}
                  onClick={() => setSelectedFile(null)}
                >
                  {busy ? 'Working… ' : ''}
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
                disabled={busy || (!String(input || '').trim() && !selectedFile)}
                onClick={send}
                title="Send"
              >
                {busy ? '…' : 'Send'}
              </button>
            </div>
            <div className="mt-1 text-[10px] text-theme-fg-muted">
              Enter = send · Shift+Enter = new line · Attach + Send runs OCR then asks GoDam AI
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
