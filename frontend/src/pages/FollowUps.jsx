import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { toast } from 'sonner';
import {
  Archive,
  Bell,
  CheckCircle2,
  FileUp,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Tag,
  Lock,
  Users,
  CalendarDays,
} from 'lucide-react';
import { authApi, notesApi, usersApi } from '../services/api';

const TABS = ['pending', 'completed', 'archived'];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const CATEGORIES = ['warehouse', 'office', 'customer', 'vendor'];
const LINK_TYPES = [
  { value: '', label: 'No link' },
  { value: 'dn', label: 'DN' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'so', label: 'SO' },
  { value: 'customer', label: 'Customer' },
  { value: 'vendor', label: 'Vendor' },
];

function fmt(v) {
  if (!v) return '-';
  return String(v).replace('T', ' ').slice(0, 16);
}

function localDateTimeValue() {
  const d = new Date();
  d.setHours(10, 0, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 16);
}

function priorityClass(priority) {
  return {
    urgent: 'bg-red-950 text-red-400 border-red-800 shadow-sm shadow-red-950',
    high: 'bg-amber-950/40 text-amber-400 border-amber-900',
    normal: 'bg-cyan-950/40 text-cyan-400 border-cyan-900',
    low: 'bg-slate-900 text-slate-400 border-slate-800',
  }[priority] || 'bg-slate-900 text-slate-400 border-slate-800';
}

function elapsedDaysText(createdAt) {
  if (!createdAt) return 'Day 1';
  const created = new Date(createdAt);
  const diffMs = Date.now() - created.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return `Day ${Math.max(1, diffDays + 1)}`;
}

export default function FollowUps({ currentUser }) {
  const [tab, setTab] = useState('pending');
  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [priority, setPriority] = useState('');
  const [linkType, setLinkType] = useState('');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({
    title: '',
    category: 'warehouse',
    priority: 'normal',
    visibility: 'public',
    link_type: '',
    link_id: '',
    link_label: '',
    assigned_to_user_id: currentUser?.id || '',
    tagged_user_ids: [],
    reminder_at: localDateTimeValue(),
    reminder_channel: 'dashboard_push',
    message: '',
  });
  const [tagDraft, setTagDraft] = useState([]);
  const fileInputRef = useRef(null);

  const canManage =
    String(currentUser?.role || '').toLowerCase() === 'admin' ||
    Boolean(currentUser?.permissions?.can_manage_followups);

  const selected = useMemo(
    () => rows.find((r) => Number(r.id) === Number(selectedId)) || rows[0] || null,
    [rows, selectedId]
  );

  const canActOnSelected = useMemo(() => {
    if (!selected) return false;
    if (canManage) return true;
    const uid = Number(currentUser?.id);
    if (Number(selected.created_by_user_id) === uid) return true;
    if (Number(selected.assigned_to_user_id) === uid) return true;
    const tagged = (selected.tagged_users || []).some((t) => Number(t.user_id) === uid);
    return tagged;
  }, [selected, currentUser?.id, canManage]);

  const load = async () => {
    setLoading(true);
    try {
      const data = await notesApi.list({ status: tab, q, priority, link_type: linkType });
      setRows(data || []);
      if (!selectedId && data?.[0]?.id) setSelectedId(data[0].id);
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Could not load follow-ups');
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id) => {
    if (!id) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await notesApi.get(id));
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Could not open follow-up');
    }
  };

  useEffect(() => {
    load();
  }, [tab]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q, priority, linkType]);

  useEffect(() => {
    if (selected?.id) loadDetail(selected.id);
  }, [selected?.id]);

  useEffect(() => {
    usersApi.list().then(setUsers).catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    const socket = io('/', {
      path: '/socket.io',
      auth: { token: authApi.getToken(), userId: currentUser?.id },
      transports: ['websocket', 'polling'],
    });
    const refresh = () => {
      load();
      if (selected?.id) loadDetail(selected.id);
    };
    socket.on('followup:changed', refresh);
    socket.on('followup:message', refresh);
    socket.on('followup:reminder', refresh);
    return () => socket.disconnect();
  }, [currentUser?.id, selected?.id, tab, q, priority, linkType]);

  const createNote = async (e) => {
    e.preventDefault();
    if (!canManage) return toast.error('You do not have permission to manage follow-ups.');
    try {
      // Ensure tagged users is empty for personal visibility
      const finalForm = {
        ...form,
        tagged_user_ids: form.visibility === 'personal' ? [] : form.tagged_user_ids,
      };
      const created = await notesApi.create(finalForm);
      toast.success('Follow-up created');
      setSelectedId(created.id);
      setForm((f) => ({
        ...f,
        title: '',
        link_id: '',
        link_label: '',
        message: '',
        tagged_user_ids: [],
        reminder_at: localDateTimeValue(),
      }));
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message || 'Could not create follow-up');
    }
  };

  const sendMessage = async () => {
    if (!selected?.id || !message.trim() || !canActOnSelected) return;
    try {
      await notesApi.addMessage(selected.id, message);
      setMessage('');
      await loadDetail(selected.id);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Could not send message');
    }
  };

  const uploadAttachment = async () => {
    if (!selected?.id || !file) return;
    try {
      await notesApi.uploadAttachment(selected.id, file);
      toast.success('Attachment uploaded');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadDetail(selected.id);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Upload failed');
    }
  };

  const markComplete = async () => {
    if (!selected?.id || !canActOnSelected) return;
    await notesApi.complete(selected.id);
    toast.success('Marked complete');
    setTab('completed');
    await load();
  };

  const saveTags = async () => {
    if (!selected?.id || !canActOnSelected) return;
    try {
      await notesApi.setTags(selected.id, tagDraft);
      toast.success('Tags updated — users notified');
      await loadDetail(selected.id);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Could not update tags');
    }
  };

  useEffect(() => {
    const ids = (detail?.note?.tagged_users || selected?.tagged_users || []).map((t) => Number(t.user_id));
    setTagDraft(ids.filter(Boolean));
  }, [selected?.id, detail?.note?.tagged_users]);

  const archive = async () => {
    if (!selected?.id || !canActOnSelected) return;
    await notesApi.archive(selected.id);
    toast.success('Archived with timestamp');
    await load();
  };

  return (
    <div className="min-h-[calc(100vh-120px)] bg-slate-950 text-slate-100 rounded-lg overflow-hidden border border-slate-800 shadow-2xl">
      <div className="px-6 py-4 border-b border-slate-800 bg-gradient-to-r from-slate-900 via-slate-950 to-slate-900 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-black tracking-wide text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-sky-300">
            Follow-Ups & Notes
          </h1>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Personal (private) or public follow-ups. Tag teammates — they get a push notification.
          </p>
        </div>
        <button
          type="button"
          className="px-3 py-1.5 rounded-md text-[11px] font-bold bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white transition-all flex items-center gap-1.5"
          onClick={load}
        >
          <RefreshCw size={13} className="text-cyan-400" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr_360px] min-h-[720px]">
        <aside className="border-r border-slate-800 bg-slate-950/60">
          <div className="p-4 border-b border-slate-800 space-y-3">
            <div className="flex rounded-lg overflow-hidden border border-slate-800 bg-slate-900 p-0.5">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-extrabold capitalize transition-all ${
                    tab === t
                      ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-950/50'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800/40'
                  }`}
                  onClick={() => {
                    setTab(t);
                    setSelectedId(null);
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 focus-within:border-cyan-500/50 transition-all">
              <Search size={14} className="text-slate-500" />
              <input
                className="bg-transparent outline-none text-[12px] w-full placeholder:text-slate-500 text-slate-100"
                placeholder="Search title, link, suggestion..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <select
                className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-2 text-[11px] text-slate-300 outline-none focus:border-cyan-500/50"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="">All priorities</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select
                className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-2 text-[11px] text-slate-300 outline-none focus:border-cyan-500/50"
                value={linkType}
                onChange={(e) => setLinkType(e.target.value)}
              >
                <option value="">All links</option>
                {LINK_TYPES.filter((x) => x.value).map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="max-h-[640px] overflow-y-auto divide-y divide-slate-900/60">
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`w-full text-left p-4 hover:bg-slate-900/40 transition-all duration-200 ${
                  Number(selected?.id) === Number(r.id)
                    ? 'bg-slate-900/70 border-l-2 border-l-cyan-500'
                    : ''
                }`}
                onClick={() => setSelectedId(r.id)}
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="font-bold text-[12px] leading-snug text-slate-100">{r.title}</div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-black bg-red-950/70 text-red-400 border border-red-900/60 flex items-center gap-0.5">
                      <CalendarDays size={10} className="text-red-500" />
                      {elapsedDaysText(r.created_at)}
                    </span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold border capitalize ${priorityClass(r.priority)}`}>
                      {r.priority}
                    </span>
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-slate-400 flex flex-wrap gap-x-2 gap-y-1">
                  <span className="text-slate-300 bg-slate-900 px-1 py-0.5 rounded border border-slate-800">{r.category}</span>
                  <span className="flex items-center gap-0.5">
                    {r.visibility === 'personal' ? '🔒 personal' : '🌐 public'}
                  </span>
                  <span>👤 {r.assigned_to_name || 'unassigned'}</span>
                  {r.tagged_user_labels ? <span className="text-cyan-400 font-medium">@{r.tagged_user_labels}</span> : null}
                  {r.overdue ? <span className="text-red-400 font-bold">overdue</span> : null}
                </div>
                <div className="mt-1.5 text-[10px] text-slate-500 truncate">{r.link_label || r.link_id || 'No linked document'}</div>
              </button>
            ))}
            {!rows.length ? (
              <div className="p-6 text-[12px] text-slate-500 text-center">
                {loading ? 'Loading...' : 'No follow-ups in this tab.'}
              </div>
            ) : null}
          </div>
        </aside>

        <main className="bg-slate-950 bg-radial-gradient">
          {selected ? (
            <div className="h-full flex flex-col">
              <div className="p-5 border-b border-slate-800 bg-slate-900/20 backdrop-blur-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-black text-slate-50 leading-tight">{selected.title}</h2>
                      <span className="text-[10px] px-2 py-0.5 rounded font-black bg-red-950 text-red-400 border border-red-800 flex items-center gap-0.5">
                        <CalendarDays size={11} className="text-red-500" />
                        {elapsedDaysText(selected.created_at)}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold border capitalize ${priorityClass(selected.priority)}`}>
                        {selected.priority}
                      </span>
                      {selected.overdue ? (
                        <span className="text-[9px] text-red-400 bg-red-950/60 border border-red-800/80 rounded px-1.5 py-0.5 font-bold">
                          Overdue
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-slate-300">{selected.category?.toUpperCase()}</span>
                      <span className="text-slate-600">•</span>
                      <span>{selected.visibility === 'personal' ? 'Personal' : 'Public'}</span>
                      <span className="text-slate-600">•</span>
                      <span className="text-slate-300">
                        {selected.link_type?.toUpperCase() || 'NO LINK'}: {selected.link_label || selected.link_id || 'None'}
                      </span>
                    </div>
                    {selected.tagged_user_labels ? (
                      <div className="mt-1.5 text-[11px] text-cyan-400 flex items-center gap-1">
                        <Tag size={12} className="text-cyan-400" /> Tagged: {selected.tagged_user_labels}
                      </div>
                    ) : null}
                  </div>
                  {canActOnSelected ? (
                    <div className="flex flex-wrap gap-2">
                      {selected.status === 'pending' ? (
                        <button
                          type="button"
                          className="px-3 py-1.5 rounded-md text-[11px] font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 flex items-center gap-1 shadow-md shadow-cyan-950/50 transition-all"
                          onClick={markComplete}
                        >
                          <CheckCircle2 size={13} /> Mark complete
                        </button>
                      ) : null}
                      {selected.status === 'completed' ? (
                        <button
                          type="button"
                          className="px-3 py-1.5 rounded-md text-[11px] font-bold bg-slate-950 border border-slate-800 text-slate-300 hover:bg-slate-800 hover:text-white flex items-center gap-1 transition-all"
                          onClick={archive}
                        >
                          <Archive size={13} /> Archive
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4 text-[11px]">
                  <div className="rounded-lg bg-slate-900/60 border border-slate-900 p-2.5">
                    <span className="text-slate-500 block text-[9px] uppercase font-bold tracking-wider">Reminder</span>
                    <span className="text-slate-300 font-semibold">{fmt(selected.reminder_at)}</span>
                  </div>
                  <div className="rounded-lg bg-slate-900/60 border border-slate-900 p-2.5">
                    <span className="text-slate-500 block text-[9px] uppercase font-bold tracking-wider">Completed</span>
                    <span className="text-slate-300 font-semibold">{fmt(selected.completed_at)}</span>
                  </div>
                  <div className="rounded-lg bg-slate-900/60 border border-slate-900 p-2.5">
                    <span className="text-slate-500 block text-[9px] uppercase font-bold tracking-wider">Archived</span>
                    <span className="text-slate-300 font-semibold">{fmt(selected.archived_at)}</span>
                  </div>
                  <div className="rounded-lg bg-slate-900/60 border border-slate-900 p-2.5">
                    <span className="text-slate-500 block text-[9px] uppercase font-bold tracking-wider">Assigned</span>
                    <span className="text-slate-300 font-semibold">{selected.assigned_to_name || 'Unassigned'}</span>
                  </div>
                </div>
                {selected.ai_suggestion ? (
                  <div className="mt-4 flex gap-2.5 rounded-lg border border-cyan-900/50 bg-cyan-950/20 p-3 text-[11px] text-cyan-200 leading-relaxed shadow-inner">
                    <Sparkles size={14} className="flex-shrink-0 mt-0.5 text-cyan-400" />
                    <span>{selected.ai_suggestion}</span>
                  </div>
                ) : null}
                {canActOnSelected && selected.status !== 'archived' ? (
                  <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2.5">
                    <div className="text-[11px] font-extrabold flex items-center gap-1 text-slate-300">
                      <Users size={13} className="text-cyan-400" /> Tag users for follow-up
                    </div>
                    <select
                      multiple
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-[11px] min-h-[72px] text-slate-300 outline-none focus:border-cyan-500/50"
                      value={tagDraft.map(String)}
                      onChange={(e) => {
                        const opts = [...e.target.selectedOptions].map((o) => Number(o.value));
                        setTagDraft(opts.filter(Boolean));
                      }}
                    >
                      {(users || [])
                        .filter((u) => Number(u.id) !== Number(currentUser?.id))
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.username || u.full_name || u.email}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-md text-[11px] font-bold bg-slate-800 text-white hover:bg-slate-700 transition-all"
                      onClick={() => void saveTags()}
                    >
                      Save tags & notify
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-4 max-h-[440px]">
                {(detail?.messages || []).map((m) => {
                  const mine = Number(m.sender_user_id) === Number(currentUser?.id);
                  return (
                    <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[80%] rounded-lg px-3.5 py-2.5 border leading-relaxed ${
                          mine
                            ? 'bg-cyan-600 text-white border-cyan-500 shadow-sm'
                            : 'bg-slate-900 border-slate-800 text-slate-100 shadow-sm'
                        }`}
                      >
                        <div className="text-[10px] opacity-75 mb-1.5 font-bold flex items-center justify-between gap-4">
                          <span>{m.sender_name || 'System'}</span>
                          <span>{fmt(m.created_at)}</span>
                        </div>
                        <div className="text-[11.5px] whitespace-pre-wrap">{m.body}</div>
                      </div>
                    </div>
                  );
                })}
                {(detail?.attachments || []).length ? (
                  <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
                    <div className="font-bold text-[11px] text-slate-300 uppercase tracking-wide mb-2.5">
                      Attachments
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {detail.attachments.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className="px-2.5 py-1.5 rounded-md text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200 transition-all border border-slate-700/50 flex items-center gap-1"
                          onClick={() => notesApi.downloadAttachment(a.id, a.original_name)}
                        >
                          <FileUp size={12} className="text-cyan-400" /> {a.original_name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {canActOnSelected && selected.status !== 'archived' ? (
                <div className="p-4 border-t border-slate-800 bg-slate-900/20 backdrop-blur-sm space-y-3">
                  <div className="flex gap-2">
                    <input
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/50"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Type an update or comment..."
                      onKeyDown={(e) => e.key === 'Enter' && void sendMessage()}
                    />
                    <button
                      type="button"
                      className="px-4 py-2 rounded-lg text-[12px] font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 flex items-center gap-1 shadow-md shadow-cyan-950/40 transition-all"
                      onClick={sendMessage}
                    >
                      <Send size={13} /> Send
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-4 items-center justify-between">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,.xls,.xlsx,.csv"
                      className="text-[11px] text-slate-400 file:bg-slate-900 file:border file:border-slate-800 file:text-slate-300 file:rounded-md file:px-2 file:py-1 file:text-[10px] file:font-bold file:mr-2 file:cursor-pointer hover:file:bg-slate-800"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                    />
                    <button
                      type="button"
                      className="px-3 py-1.5 rounded-md text-[11px] font-bold bg-slate-850 text-slate-300 border border-slate-800 hover:text-white hover:bg-slate-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                      onClick={uploadAttachment}
                      disabled={!file}
                    >
                      <FileUp size={12} /> Upload File
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="h-full grid place-items-center text-slate-600">
              <div className="text-center">
                <MessageSquareText className="mx-auto mb-2 text-slate-600" size={32} />
                <span className="text-[12px] block">Select or create a follow-up.</span>
              </div>
            </div>
          )}
        </main>

        <aside className="bg-slate-900/30 p-4 divide-y divide-slate-800/80 space-y-4">
          <form onSubmit={createNote} className="space-y-3.5">
            <div className="flex items-center gap-2 text-xs font-black text-slate-200 uppercase tracking-wider">
              <Plus size={15} className="text-cyan-400" /> New follow-up
            </div>
            <input
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/50"
              placeholder="Title or subject..."
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
            />
            <textarea
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/50 min-h-[96px]"
              placeholder="Provide first note message or context..."
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              required
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[9px] uppercase font-bold text-slate-500 block mb-1">Category</span>
                <select
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-[11px] text-slate-300 outline-none focus:border-cyan-500/50 capitalize"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                >
                  {CATEGORIES.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[9px] uppercase font-bold text-slate-500 block mb-1">Priority</span>
                <select
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-[11px] text-slate-300 outline-none focus:border-cyan-500/50 capitalize"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                >
                  {PRIORITIES.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[9px] uppercase font-bold text-slate-500 block mb-1">Visibility</span>
                <select
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-[11px] text-slate-300 outline-none focus:border-cyan-500/50"
                  value={form.visibility}
                  onChange={(e) => setForm({ ...form, visibility: e.target.value })}
                >
                  <option value="public">🌐 Public (Team)</option>
                  <option value="personal">🔒 Private</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[9px] uppercase font-bold text-slate-500 block mb-1">Assignee</span>
                <select
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-[11px] text-slate-300 outline-none focus:border-cyan-500/50"
                  value={form.assigned_to_user_id}
                  onChange={(e) => setForm({ ...form, assigned_to_user_id: e.target.value })}
                >
                  <option value="">Assign to me</option>
                  {(users || []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username || u.full_name || u.email}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {form.visibility === 'public' ? (
              <label className="block text-[11px] text-slate-400">
                <span className="flex items-center gap-1 mb-1 font-bold text-slate-300">
                  <Tag size={13} className="text-cyan-400" /> Tag users (push notification)
                </span>
                <select
                  multiple
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-[11px] min-h-[72px] text-slate-300 outline-none focus:border-cyan-500/50"
                  value={(form.tagged_user_ids || []).map(String)}
                  onChange={(e) => {
                    const opts = [...e.target.selectedOptions].map((o) => Number(o.value));
                    setForm({ ...form, tagged_user_ids: opts.filter(Boolean) });
                  }}
                >
                  {(users || [])
                    .filter((u) => Number(u.id) !== Number(currentUser?.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username || u.full_name || u.email}
                      </option>
                    ))}
                </select>
                <span className="text-[10px] text-slate-500 mt-1 block">
                  <span className="inline-flex items-center gap-1">
                    <Users size={10} /> Everyone can see; tagged users are notified.
                  </span>
                </span>
              </label>
            ) : (
              <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-400">
                <span className="flex items-center gap-1.5 font-bold text-slate-300">
                  <Lock size={12} className="text-cyan-400" /> Private Record Lock
                </span>
                <p className="mt-1 text-[10px] text-slate-500 leading-normal">
                  Teammate tagging is disabled for private records. This follow-up will be completely hidden from others and only shown to you.
                </p>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="text-[9px] uppercase font-bold text-slate-500 block mb-1">Doc Link</span>
                <select
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-2 text-[11px] text-slate-300 outline-none focus:border-cyan-500/50"
                  value={form.link_type}
                  onChange={(e) => setForm({ ...form, link_type: e.target.value })}
                >
                  {LINK_TYPES.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-2 block">
                <span className="text-[9px] uppercase font-bold text-slate-500 block mb-1">Ref ID / Number</span>
                <input
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-[12px] text-slate-100 placeholder:text-slate-600 outline-none focus:border-cyan-500/50"
                  placeholder="e.g. HW-PO-510000..."
                  value={form.link_id}
                  onChange={(e) => setForm({ ...form, link_id: e.target.value, link_label: e.target.value })}
                />
              </label>
            </div>
            <label className="block text-[11px] text-slate-400">
              <span className="flex items-center gap-1 mb-1 font-bold text-slate-300">
                <Bell size={13} className="text-cyan-400" /> Reminder Schedule
              </span>
              <input
                type="datetime-local"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-[12px] text-slate-100 outline-none focus:border-cyan-500/50"
                value={form.reminder_at}
                onChange={(e) => setForm({ ...form, reminder_at: e.target.value })}
              />
            </label>
            <select
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-2 text-[11px] text-slate-300 outline-none focus:border-cyan-500/50"
              value={form.reminder_channel}
              onChange={(e) => setForm({ ...form, reminder_channel: e.target.value })}
            >
              <option value="dashboard_push">🔔 Dashboard + Push notification</option>
              <option value="dashboard_push_whatsapp">💬 Dashboard + Push + WhatsApp</option>
              <option value="dashboard_push_email">✉️ Dashboard + Push + Email</option>
            </select>
            <button
              type="submit"
              className="px-4 py-2.5 rounded-lg text-[12px] font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 w-full shadow-lg shadow-cyan-950/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!canManage}
            >
              Create follow-up
            </button>
            {!canManage ? (
              <div className="text-[10px] text-amber-300 text-center font-medium bg-amber-950/20 border border-amber-900/30 rounded p-1.5">
                Your role can view follow-ups but cannot create them.
              </div>
            ) : null}
          </form>
        </aside>
      </div>
    </div>
  );
}
