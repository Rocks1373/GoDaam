import { BrowserRouter as Router, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import {
  Package,
  Layers,
  Truck,
  BarChart3,
  LogOut,
  Users,
  FileText,
  UploadCloud,
  KeySquare,
  ShieldCheck,
  ClipboardList,
  UserCog,
  GripVertical,
  Database,
  PieChart,
  LineChart,
  FileSpreadsheet,
  Image,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Dashboard from './pages/Dashboard';
import MainStock from './pages/MainStock';
import StockByRack from './pages/StockByRack';
import Customers from './pages/Customers';
import DeliveryNote from './pages/DeliveryNote';
import OutboundUpload from './pages/OutboundUpload';
import UsersAdmin from './pages/UsersAdmin';
import RolePermissions from './pages/RolePermissions';
import PickedOrdersAdmin from './pages/PickedOrdersAdmin';
import PickChangeRequests from './pages/PickChangeRequests';
import Notifications from './pages/Notifications';
import PodInbox from './pages/PodInbox';
import AdminMaintenance from './pages/AdminMaintenance';
import Login from './pages/Login';
import CarrierMaster from './pages/CarrierMaster';
import VendorMaster from './pages/VendorMaster';
import VendorItems from './pages/VendorItems';
import InboundReport from './pages/InboundReport';
import OutboundReport from './pages/OutboundReport';
import DeliveryReport from './pages/DeliveryReport';
import ReportExportPage from './pages/ReportExportPage';
import { authApi, notificationsApi } from './services/api';
import './index.css';

const SIDEBAR_WIDTH_KEY = 'godam_sidebar_width_px';
const SIDEBAR_MIN = 120;
const SIDEBAR_MAX = 440;
const SIDEBAR_DEFAULT = 160;

function readSidebarWidth() {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const n = v ? parseInt(v, 10) : SIDEBAR_DEFAULT;
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

/** Stable wrapper — must NOT be defined inside App (polling/state updates would remount all routes). */
function RequireAuth({ checking, user, children }) {
  if (checking) return <div className="p-4 text-xs">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifUnread, setNotifUnread] = useState(0);
  const [notifRows, setNotifRows] = useState([]);
  const notifUnreadSigRef = useRef('');
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const sidebarDrag = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(SIDEBAR_DEFAULT);
  const sidebarWidthRef = useRef(sidebarWidth);

  sidebarWidthRef.current = sidebarWidth;

  useEffect(() => {
    const onMove = (e) => {
      if (!sidebarDrag.current) return;
      const dx = e.clientX - dragStartX.current;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, dragStartWidth.current + dx));
      setSidebarWidth(next);
    };
    const onUp = () => {
      if (!sidebarDrag.current) return;
      sidebarDrag.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
      } catch {
        // ignore
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startSidebarResize = (e) => {
    e.preventDefault();
    sidebarDrag.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidthRef.current;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const resetSidebarWidth = () => {
    setSidebarWidth(SIDEBAR_DEFAULT);
    sidebarWidthRef.current = SIDEBAR_DEFAULT;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_DEFAULT));
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const boot = async () => {
      const token = authApi.getToken();
      if (!token) {
        setChecking(false);
        return;
      }
      try {
        const me = await authApi.me();
        setUser(me.user);
      } catch {
        authApi.logout();
      } finally {
        setChecking(false);
      }
    };
    boot();
  }, []);

  const logout = () => {
    authApi.logout();
    setUser(null);
  };

  const prevDesktopNotifCountRef = useRef(0);

  // Poll unread notifications for badge (also while tab hidden so mobile/web stay in sync).
  useEffect(() => {
    if (!user) {
      notifUnreadSigRef.current = '';
      prevDesktopNotifCountRef.current = 0;
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const { count } = await notificationsApi.unreadCount();
        if (!alive) return;
        let list = [];
        if (Number(count) > 0) {
          list = await notificationsApi.list({ unread_only: true });
        }
        const listNorm = list || [];
        const sig = `${Number(count) || 0}:${listNorm.map((r) => r.id).join(',')}`;
        if (sig !== notifUnreadSigRef.current) {
          notifUnreadSigRef.current = sig;
          setNotifRows(listNorm);
          setNotifUnread(Number(count) || 0);
        }
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          prevDesktopNotifCountRef.current = Number(count) || 0;
        }
      } catch {
        // ignore
      }
    };
    tick();
    const t = setInterval(tick, 30000);
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user]);

  // Browser notification when unread count goes up while the tab is in the background (after user grants permission in the browser).
  useEffect(() => {
    if (!user) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const prev = prevDesktopNotifCountRef.current;
    if (notifUnread < prev) {
      prevDesktopNotifCountRef.current = notifUnread;
      return;
    }
    if (notifUnread > prev && notifUnread > 0) {
      const first = (notifRows || [])[0];
      try {
        new Notification(first?.title || 'GoDaam', {
          body: first?.body || 'New notification',
          icon: '/LOGO.png',
          tag: `godam-notify-${first?.id ?? 'new'}`,
        });
      } catch {
        // ignore
      }
    }
    prevDesktopNotifCountRef.current = notifUnread;
  }, [user, notifUnread, notifRows]);

  return (
    <Router
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/dashboard" replace /> : <Login onLoggedIn={setUser} />}
        />
        <Route
          path="/*"
          element={
            <RequireAuth checking={checking} user={user}>
              <div className="min-h-screen bg-warehouse-gray text-xs">
                <header className="bg-white shadow-sm border-b border-gray-200">
                  <div className="max-w-[1920px] mx-auto px-2 sm:px-3">
                    <div className="flex justify-between items-center py-1.5 gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <img
                          src="/LOGO.png"
                          alt="GoDaam"
                          className="h-9 w-auto max-w-[140px] object-contain flex-shrink-0"
                        />
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <div className="text-[10px] font-semibold text-gray-600 hidden sm:block">
                          {user?.username} ({user?.role})
                        </div>
                        <div className="relative">
                          <button
                            type="button"
                            className="btn-secondary relative"
                            onClick={() => setNotifOpen((s) => !s)}
                            title="Notifications"
                          >
                            Notifications
                            {notifUnread ? (
                              <span className="ml-2 inline-flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5">
                                {notifUnread}
                              </span>
                            ) : null}
                          </button>
                          {notifOpen ? (
                            <div className="absolute right-0 mt-2 w-[360px] max-w-[85vw] rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden z-50">
                              <div className="px-3 py-2 flex items-center justify-between bg-gray-50">
                                <div className="text-[11px] font-bold text-gray-700">Unread</div>
                                <NavLink
                                  to="/notifications"
                                  className="text-[11px] font-bold text-primary-700 hover:underline"
                                  onClick={() => setNotifOpen(false)}
                                >
                                  View all
                                </NavLink>
                              </div>
                              <div className="max-h-[340px] overflow-y-auto">
                                {(notifRows || []).length ? (
                                  notifRows.slice(0, 12).map((n) => (
                                    <NavLink
                                      key={n.id}
                                      to={
                                        String(n.title || '').toLowerCase().includes('pick change request')
                                          ? '/pick-change-requests'
                                          : '/notifications'
                                      }
                                      className="block px-3 py-2 hover:bg-gray-50 border-t border-gray-100"
                                      onClick={async () => {
                                        try {
                                          await notificationsApi.markRead(n.id);
                                          const rows = await notificationsApi.list({ unread_only: true });
                                          setNotifRows(rows || []);
                                          setNotifUnread((rows || []).length);
                                        } catch {
                                          // ignore
                                        } finally {
                                          setNotifOpen(false);
                                        }
                                      }}
                                    >
                                      <div className="text-[11px] font-bold text-gray-900">{n.title}</div>
                                      <div className="text-[11px] text-gray-600 line-clamp-2">{n.body}</div>
                                    </NavLink>
                                  ))
                                ) : (
                                  <div className="px-3 py-3 text-[11px] text-gray-500">No unread notifications.</div>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                        <button type="button" className="btn-secondary flex items-center gap-1" onClick={logout}>
                          <LogOut size={14} />
                          Logout
                        </button>
                      </div>
                    </div>
                  </div>
                </header>

                <div className="flex w-full px-2 sm:px-3 py-2 gap-2 items-stretch">
                  <div
                    className="hidden lg:flex shrink-0 sticky top-2 self-start max-h-[calc(100vh-2.75rem)] rounded-lg shadow-sm border border-gray-200 bg-white overflow-hidden"
                    style={{ width: sidebarWidth }}
                  >
                    <aside className="flex-1 min-w-0 p-2 overflow-y-auto overflow-x-hidden">
                    <nav className="space-y-1">
                      <NavLink
                        to="/dashboard"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <BarChart3 className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Dashboard</span>
                      </NavLink>

                      <NavLink
                        to="/main-stock"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <Package className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Main Stock</span>
                      </NavLink>

                      <NavLink
                        to="/stock-by-rack/summary"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <Layers className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Stock By Rack</span>
                      </NavLink>

                      {(user?.role === 'admin' || user?.permissions?.can_upload_outbound) && (
                        <NavLink
                          to="/outbound-upload"
                          className={({ isActive }) =>
                            `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                              isActive
                                ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                            }`
                          }
                        >
                          <UploadCloud className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="truncate">Outbound Upload</span>
                        </NavLink>
                      )}

                      {(user?.role === 'admin' || user?.permissions?.can_view_picked_table) && (
                        <NavLink
                          to="/picked-orders"
                          className={({ isActive }) =>
                            `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                              isActive
                                ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                            }`
                          }
                        >
                          <ClipboardList className="w-3.5 h-3.5 flex-shrink-0" />
                          <span className="truncate">Pickup / Picked Orders</span>
                        </NavLink>
                      )}

                      <NavLink
                        to="/customers"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <Users className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Customers</span>
                      </NavLink>

                      <NavLink
                        to="/delivery-note"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Delivery Order / Delivery Note</span>
                      </NavLink>

                      <NavLink
                        to="/pod-inbox"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <Image className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">POD inbox</span>
                      </NavLink>

                      <div className="flex items-center gap-2 px-2 py-1 mt-2 text-[10px] font-bold text-gray-400 uppercase tracking-wide">
                        <PieChart className="w-3 h-3" />
                        Reports
                      </div>
                      <NavLink
                        to="/reports/inbound"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Inbound Report</span>
                      </NavLink>
                      <NavLink
                        to="/reports/outbound"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <LineChart className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Outbound Report</span>
                      </NavLink>
                      <NavLink
                        to="/reports/delivery"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Delivery Report</span>
                      </NavLink>
                      <NavLink
                        to="/reports/stock-by-rack-report"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <Layers className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Stock By Rack Report</span>
                      </NavLink>
                      <NavLink
                        to="/reports/main-stock-report"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <Package className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Main Stock Report</span>
                      </NavLink>
                      <NavLink
                        to="/reports/sap-stock"
                        className={({ isActive }) =>
                          `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                            isActive
                              ? 'bg-primary-50 text-primary-700 border border-primary-200'
                              : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                          }`
                        }
                      >
                        <Database className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">SAP Stock Report</span>
                      </NavLink>

                      {user?.role === 'admin' && (
                        <>
                          <div className="flex items-center gap-2 px-2 py-1 mt-2 text-[10px] font-bold text-gray-400 uppercase tracking-wide">
                            <ShieldCheck className="w-3 h-3" />
                            Admin
                          </div>
                          <NavLink
                            to="/carrier-master"
                            className={({ isActive }) =>
                              `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                                isActive
                                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                  : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                              }`
                            }
                          >
                            <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">Carrier Master</span>
                          </NavLink>
                          <NavLink
                            to="/vendor-master"
                            className={({ isActive }) =>
                              `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                                isActive
                                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                  : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                              }`
                            }
                          >
                            <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">Vendor Master</span>
                          </NavLink>
                          <NavLink
                            to="/vendor-items"
                            className={({ isActive }) =>
                              `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                                isActive
                                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                  : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                              }`
                            }
                          >
                            <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">Vendor Items</span>
                          </NavLink>
                          <NavLink
                            to="/users"
                            className={({ isActive }) =>
                              `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                                isActive
                                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                  : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                              }`
                            }
                          >
                            <UserCog className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">Users</span>
                          </NavLink>
                          <NavLink
                            to="/role-permissions"
                            className={({ isActive }) =>
                              `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                                isActive
                                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                  : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                              }`
                            }
                          >
                            <KeySquare className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">Role Permissions</span>
                          </NavLink>
                          <NavLink
                            to="/pick-change-requests"
                            className={({ isActive }) =>
                              `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                                isActive
                                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                  : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                              }`
                            }
                          >
                            <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">Pick Requests</span>
                          </NavLink>
                          <NavLink
                            to="/admin-maintenance"
                            className={({ isActive }) =>
                              `flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] font-bold transition-all ${
                                isActive
                                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                                  : 'text-gray-700 hover:bg-gray-50 border border-transparent'
                              }`
                            }
                          >
                            <Database className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">Outbound DB</span>
                          </NavLink>
                        </>
                      )}
                    </nav>
                    </aside>
                    <button
                      type="button"
                      aria-label="Drag to resize sidebar"
                      title="Drag to resize · Double-click to reset width"
                      onMouseDown={startSidebarResize}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        resetSidebarWidth();
                      }}
                      className="group relative w-3 shrink-0 cursor-col-resize border-l border-gray-200 bg-gradient-to-b from-gray-50 to-gray-100 hover:from-primary-50 hover:to-primary-100 hover:border-primary-300 flex flex-col items-center justify-center gap-0.5 touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-inset"
                    >
                      <span className="pointer-events-none flex flex-col items-center gap-0.5 text-[10px] leading-none font-bold text-gray-400 group-hover:text-primary-600" aria-hidden>
                        <span className="opacity-70">+</span>
                        <GripVertical className="w-3 h-3" strokeWidth={2.5} />
                        <span className="opacity-70">+</span>
                      </span>
                    </button>
                  </div>

                  <main className="flex-1 min-w-0 pb-4">
                    <Routes>
                      <Route path="/dashboard" element={<Dashboard />} />
                      <Route path="/reports/inbound" element={<InboundReport />} />
                      <Route path="/reports/outbound" element={<OutboundReport />} />
                      <Route path="/reports/delivery" element={<DeliveryReport />} />
                      <Route
                        path="/reports/stock-by-rack-report"
                        element={<ReportExportPage title="Stock By Rack Report" fileSlug="stock-by-rack" endpoint="/reports/stock-by-rack" />}
                      />
                      <Route
                        path="/reports/main-stock-report"
                        element={<ReportExportPage title="Main Stock Report" fileSlug="main-stock" endpoint="/reports/main-stock" />}
                      />
                      <Route
                        path="/reports/sap-stock"
                        element={
                          <ReportExportPage
                            title="SAP Stock Report"
                            fileSlug="sap-stock"
                            endpoint="/reports/sap-stock"
                            hint="SAP-related rows from main stock (SAP qty or SAP part number)."
                          />
                        }
                      />
                      <Route path="/main-stock" element={<MainStock />} />
                      <Route path="/stock-by-rack/*" element={<StockByRack />} />
                      <Route path="/pick-suggestion" element={<Navigate to="/dashboard" replace />} />
                      <Route path="/outbound-upload" element={<OutboundUpload />} />
                      <Route path="/picked-orders" element={<PickedOrdersAdmin />} />
                      <Route path="/customers" element={<Customers />} />
                      <Route path="/delivery-note" element={<DeliveryNote />} />
                      <Route path="/pod-inbox" element={<PodInbox />} />
                      <Route path="/carrier-master" element={<CarrierMaster />} />
                      <Route path="/vendor-master" element={<VendorMaster />} />
                      <Route path="/vendor-items" element={<VendorItems />} />
                      <Route path="/users" element={<UsersAdmin />} />
                      <Route path="/role-permissions" element={<RolePermissions />} />
                      <Route path="/pick-change-requests" element={<PickChangeRequests />} />
                      <Route path="/admin-maintenance" element={<AdminMaintenance />} />
                      <Route path="/notifications" element={<Notifications />} />
                      <Route path="/" element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                  </main>
                </div>
              </div>
            </RequireAuth>
          }
        />
      </Routes>
    </Router>
  );
}

export default App;
