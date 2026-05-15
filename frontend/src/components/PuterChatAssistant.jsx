import { useEffect, useRef, useState } from 'react';
import { Bot, Copy, FileText, Image, Loader2, Paperclip, Send, Trash2, X } from 'lucide-react';
import { chatWithPuter, analyzeImage, ocrImage } from '../services/puterAI';
import { ensureSignedIn } from '../services/puterAuth';

const SYSTEM_PROMPT = `You are the GoDam warehouse AI assistant. You help with:
- Warehouse operations: inbound, putaway, picking, packing, outbound, FIFO
- SAP integration: stock movements, delivery notes, purchase orders
- Logistics: delivery tracking, DN creation, driver assignment, POD management
- OCR results: parsing invoice/DN/PO fields, verifying extracted data
- Troubleshooting: common errors, missing data, stock discrepancies

Give short, practical answers. Use bullet points for lists. If you don't know something specific to GoDam data, say so honestly.`;

function nowIso() {
  try { return new Date().toISOString(); } catch { return ''; }
}

function safeClipboard(text) {
  const t = String(text || '');
  if (!t) return;
  navigator.clipboard?.writeText(t).catch(() => {});
}

function isSupportedVisualFile(file) {
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return type.startsWith('image/') || type === 'application/pdf' || /\.(png|jpe?g|webp|gif|bmp|tiff?|pdf)$/i.test(name);
}

export default function PuterChatAssistant({ contextInfo }) {
  const [messages, setMessages] = useState([
    {
      id: 'sys-0',
      role: 'assistant',
      ts: nowIso(),
      text: "Hi — I'm the GoDam AI assistant powered by Puter. Ask me about warehouse operations, delivery notes, stock management, SAP processes, or upload a document for analysis.",
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState(null);
  const listRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    setTimeout(() => {
      listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    }, 50);
  }, [messages.length]);

  const addMessage = (role, text) => {
    setMessages((m) => [...m, { id: `${role[0]}-${Date.now()}`, role, ts: nowIso(), text }]);
  };

  const clearChat = () => {
    setMessages([
      {
        id: `sys-${Date.now()}`,
        role: 'assistant',
        ts: nowIso(),
        text: 'Chat cleared. Ask me about warehouse processes, OCR results, or upload a document.',
      },
    ]);
    setError('');
    setInput('');
    setFile(null);
  };

  const send = async () => {
    const text = String(input || '').trim();
    if ((!text && !file) || busy) return;

    setError('');
    setBusy(true);

    try {
      await ensureSignedIn();

      if (file) {
        const prompt = text || 'Analyze this warehouse/logistics document. Extract all visible text, identify document type, and list key fields (PO, SO, DN, invoice numbers, dates, quantities, vendor/customer).';
        addMessage('user', `${file.name}\n${prompt}`);
        setInput('');

        if (text.toLowerCase().includes('ocr') || !text) {
          const ocrResult = await ocrImage(file);
          addMessage('assistant', `OCR result:\n\n${ocrResult || 'No text detected.'}`);
        } else {
          const analysis = await analyzeImage(file, prompt);
          addMessage('assistant', analysis || 'No analysis returned.');
        }
        setFile(null);
      } else {
        addMessage('user', text);
        setInput('');

        const history = messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-10)
          .map((m) => ({ role: m.role, content: m.text }));

        const systemMessages = [{ role: 'system', content: SYSTEM_PROMPT }];

        if (contextInfo) {
          systemMessages.push({
            role: 'system',
            content: `Current context: ${contextInfo}`,
          });
        }

        const answer = await chatWithPuter([...systemMessages, ...history, { role: 'user', content: text }]);
        addMessage('assistant', answer || 'No response.');
      }
    } catch (e) {
      setError(e.message || 'Request failed');
      addMessage('assistant', `Error: ${e.message || 'Request failed'}`);
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    setError('');
    if (!f) return;
    if (!isSupportedVisualFile(f)) {
      setError('Choose an image or PDF file.');
      return;
    }
    setFile(f);
  };

  return (
    <div className="rounded-xl border border-theme-border bg-theme-card overflow-hidden flex flex-col h-[520px]">
      <div className="px-3 py-2 bg-theme-muted border-b border-theme-border flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-theme-primary text-white flex items-center justify-center flex-shrink-0">
            <Bot size={18} />
          </div>
          <div className="min-w-0">
            <div className="text-[12px] font-bold text-theme-fg truncate">GoDam AI Chat</div>
            <div className="text-[10px] text-theme-fg-muted truncate">Powered by Puter</div>
          </div>
        </div>
        <button type="button" className="btn-secondary px-2 py-1" title="Clear chat" onClick={clearChat}>
          <Trash2 size={14} />
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[88%] rounded-lg px-3 py-2 border text-[11px] whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-theme-primary text-white border-theme-border'
                  : 'bg-theme-card text-theme-fg border-theme-border'
              }`}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">{m.text}</div>
                {m.role === 'assistant' && (
                  <button type="button" className="opacity-70 hover:opacity-100 flex-shrink-0" title="Copy" onClick={() => safeClipboard(m.text)}>
                    <Copy size={13} />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-lg px-3 py-2 border border-theme-border bg-theme-card text-[11px] text-theme-fg-muted flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" /> Thinking…
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-theme-border bg-theme-card">
        {error && <div className="mb-2 text-[10px] text-red-600 font-semibold">{error}</div>}

        <input ref={fileRef} type="file" className="hidden" accept="image/*,.pdf" onChange={onPickFile} />

        <div className="mb-2 flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            className="btn-secondary px-2 py-1 inline-flex items-center gap-1 text-[10px]"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            <Paperclip size={13} />
            Attach
          </button>
          {file && (
            <button
              type="button"
              className="flex-1 min-w-0 truncate rounded-md border border-theme-border bg-theme-page px-2 py-1 text-left text-[10px] text-theme-fg-muted"
              title={file.name}
              onClick={() => setFile(null)}
            >
              {file.name} (click to remove)
            </button>
          )}
        </div>

        <div className="flex items-end gap-2">
          <textarea
            className="w-full rounded-lg border border-theme-border bg-theme-page text-theme-fg px-3 py-2 text-[11px] min-h-[44px] max-h-[110px] outline-none focus:ring-2 focus:ring-[var(--ring-primary)] resize-none"
            placeholder={file ? 'Add instructions for image analysis, or press Send for OCR…' : 'Ask about warehouse processes, SAP, delivery notes…'}
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
            className="btn-primary px-3 py-2 inline-flex items-center gap-1"
            disabled={busy || (!String(input || '').trim() && !file)}
            onClick={send}
          >
            <Send size={14} />
          </button>
        </div>

        <div className="mt-1 text-[10px] text-theme-fg-muted">
          Enter = send · Shift+Enter = new line · Attach image/PDF for OCR
        </div>
      </div>
    </div>
  );
}
