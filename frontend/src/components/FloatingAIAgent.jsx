import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Copy, Trash2, X } from 'lucide-react';
import { aiAgentApi } from '../services/aiAgentApi';

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

export default function FloatingAIAgent({ user }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [input, setInput] = useState('');
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
      setErr(e?.message || 'AI request failed');
      setMessages((m) => [
        ...m,
        {
          id: `aerr-${Date.now()}`,
          role: 'assistant',
          ts: nowIso(),
          text:
            'I could not reach the AI service right now. Please try again, or ask an admin to check `/api/ai/health`.',
        },
      ]);
    } finally {
      setBusy(false);
      setTimeout(() => {
        lastSentRef.current = '';
      }, 250);
    }
  };

  return (
    <>
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
                disabled={busy || !String(input || '').trim()}
                onClick={send}
                title="Send"
              >
                {busy ? '…' : 'Send'}
              </button>
            </div>
            <div className="mt-1 text-[10px] text-theme-fg-muted">
              Enter = send · Shift+Enter = new line
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

