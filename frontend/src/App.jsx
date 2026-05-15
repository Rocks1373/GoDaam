import { BrowserRouter as Router, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { CardDisplayProvider } from './context/CardDisplayContext';
import { ThemeProvider } from './context/ThemeContext';
import CardSizeControls from './components/CardSizeControls';
import ThemeSwitcher from './components/ThemeSwitcher';
import { LogOut, Warehouse } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Dashboard from './pages/Dashboard';
import MainStock from './pages/MainStock';
import StockByRack from './pages/StockByRack';
import Customers from './pages/Customers';
import DeliveryNote from './pages/DeliveryNote';
import OutboundUpload from './pages/OutboundUpload';
import UsersAdmin from './pages/UsersAdmin';
import WarehousesAdmin from './pages/WarehousesAdmin';
import RolePermissions from './pages/RolePermissions';
import PickChangeRequests from './pages/PickChangeRequests';
import Notifications from './pages/Notifications';
import PodInbox from './pages/PodInbox';
import AdminBomParts from './pages/AdminBomParts';
import Login from './pages/Login';
import TransportationDetails from './pages/TransportationDetails';
import VendorMaster from './pages/VendorMaster';
import VendorItems from './pages/VendorItems';
import InboundReport from './pages/InboundReport';
import OutboundReport from './pages/OutboundReport';
import DeliveryReport from './pages/DeliveryReport';
import ReportExportPage from './pages/ReportExportPage';
import SapStock from './pages/SapStock';
import StockComparisonReport from './pages/StockComparisonReport';
import AuditLogReport from './pages/AuditLogReport';
import SalesOrderDocuments from './pages/SalesOrderDocuments';
import SalesOrderDocumentsReport from './pages/SalesOrderDocumentsReport';
import UnderConstruction from './pages/UnderConstruction';
import MobileApps from './pages/MobileApps';
import PuterTools from './pages/PuterTools';
import { authApi, notificationsApi } from './services/api';
import FloatingAIAgent from './components/FloatingAIAgent';
import AppTopNav from './components/AppTopNav';
import { WarehouseProvider, useWarehouse } from './context/WarehouseContext';
import './index.css';

function sessionUserIsValid(user) {
  const id = user && typeof user === 'object' ? Number(user.id) : NaN;
  return Number.isFinite(id) && id > 0;
}

/** Stable wrapper — must NOT be defined inside App (polling/state updates would remount all routes). */
function RequireAuth({ checking, user, children }) {
  if (checking) return <div className="p-4 text-xs">Loading…</div>;
  if (!sessionUserIsValid(user)) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ user, children }) {
  if (!sessionUserIsValid(user)) return <Navigate to="/login" replace />;
  if (String(user.role || '').toLowerCase() !== 'admin') {
    return <Navigate to="/dashboard" replace />;
  }
  return children;
}


function WarehouseToolbar() {
  const { warehouses, selectedWarehouseId, setSelectedWarehouse, isAllWarehouses, isAdmin } = useWarehouse();
  const val = isAllWarehouses ? 'all' : String(selectedWarehouseId || '');
  return (
    <label className="flex items-center gap-1 text-[10px] text-theme-fg-muted">
      <Warehouse className="w-3.5 h-3.5" aria-hidden />
      <span className="hidden md:inline">Warehouse</span>
      <select
        className="text-[10px] border border-theme-border rounded-md px-1.5 py-0.5 bg-theme-card shadow-sm max-w-[140px] transition-[border-color,box-shadow] duration-200"
        value={val}
        onChange={(e) => {
          const v = e.target.value;
          setSelectedWarehouse(v === 'all' ? 'all' : Number(v));
          window.dispatchEvent(new Event('godam-warehouse-changed'));
        }}
      >
        {isAdmin ? <option value="all">All warehouses</option> : null}
        {(warehouses || []).map((w) => (
          <option key={w.id} value={String(w.id)}>
            {w.warehouse_code || w.id} — {w.warehouse_name || ''}
            {isAdmin && w.warehouse_number ? ` (${w.warehouse_number})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifUnread, setNotifUnread] = useState(0);
  const [notifRows, setNotifRows] = useState([]);
  const notifUnreadSigRef = useRef('');
  const notifMenuRef = useRef(null);

  useEffect(() => {
    if (!notifOpen) return undefined;
    const onPointerDown = (e) => {
      const root = notifMenuRef.current;
      if (root && !root.contains(e.target)) setNotifOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setNotifOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [notifOpen]);

  useEffect(() => {
    const boot = async () => {
      const token = authApi.getToken();
      if (!token) {
        setChecking(false);
        return;
      }
      try {
        const me = await authApi.me();
        if (me?.user && sessionUserIsValid(me.user)) {
          setUser(me.user);
        } else {
          authApi.logout();
          setUser(null);
        }
      } catch {
        authApi.logout();
        setUser(null);
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
      <ThemeProvider>
      <Routes>
        <Route
          path="/login"
          element={sessionUserIsValid(user) ? <Navigate to="/dashboard" replace /> : <Login onLoggedIn={setUser} />}
        />
        <Route
          path="/*"
          element={
            <RequireAuth checking={checking} user={user}>
              <WarehouseProvider user={user}>
              <CardDisplayProvider>
              <div className="app-shell min-h-screen bg-theme-page text-xs">
                <header className="app-topbar">
                  <div className="app-topbar__inner max-w-[1920px] mx-auto px-2 sm:px-3">
                    <div className="app-topbar__row flex justify-between items-center py-2 gap-2">
                      <div className="app-topbar__brand flex items-center gap-2.5 min-w-0">
                        <img
                          src="/LOGO.png"
                          alt="GoDaam"
                          className="h-9 w-auto max-w-[140px] object-contain flex-shrink-0 drop-shadow-sm"
                        />
                        <span className="app-topbar__product hidden md:inline">Warehouse</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <WarehouseToolbar />
                        <div className="text-[10px] font-semibold text-theme-fg-muted hidden sm:block">
                          {user?.username} ({user?.role})
                        </div>
                        <ThemeSwitcher />
                        <CardSizeControls />
                        <div className="relative" ref={notifMenuRef}>
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
                            <div
                              className="absolute right-0 mt-2 w-[360px] max-w-[85vw] rounded-xl border border-theme-border bg-theme-elevate overflow-hidden z-50"
                              style={{ boxShadow: 'var(--shadow-raised)' }}
                            >
                              <div className="px-3 py-2 flex items-center justify-between bg-theme-muted border-b border-theme-border">
                                <div className="text-[11px] font-bold text-theme-fg-secondary">Unread</div>
                                <NavLink
                                  to="/notifications"
                                  className="text-[11px] font-bold text-theme-primary hover:underline"
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
                                      className="block px-3 py-2 hover:bg-theme-muted border-t border-theme-border"
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
                                      <div className="text-[11px] font-bold text-theme-fg">{n.title}</div>
                                      <div className="text-[11px] text-theme-fg-muted line-clamp-2">{n.body}</div>
                                    </NavLink>
                                  ))
                                ) : (
                                  <div className="px-3 py-3 text-[11px] text-theme-fg-muted">No unread notifications.</div>
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
                    <AppTopNav user={user} />
                  </div>
                </header>

                <div className="app-workspace app-workspace--topnav-only flex w-full px-2 sm:px-3 py-2">
                  <main className="app-main flex-1 min-w-0 pb-4 w-full">
                    <Routes>
                      <Route path="/dashboard" element={<Dashboard currentUser={user} />} />
                      <Route path="/reports/inbound" element={<InboundReport />} />
                      <Route path="/reports/outbound" element={<OutboundReport />} />
                      <Route path="/reports/delivery" element={<DeliveryReport />} />
                      <Route path="/reports/audit-log" element={<AuditLogReport />} />
                      <Route path="/reports/sales-order-documents" element={<SalesOrderDocumentsReport />} />
                      <Route
                        path="/reports/stock-by-rack-report"
                        element={<ReportExportPage title="Stock By Rack Report" fileSlug="stock-by-rack" endpoint="/reports/stock-by-rack" />}
                      />
                      <Route
                        path="/reports/rack-balance-adjustments"
                        element={
                          <ReportExportPage
                            title="Rack balance adjustments"
                            fileSlug="rack-balance-adjustments"
                            endpoint="/reports/rack-balance-adjustments"
                            hint="Admin +/− rack corrections; related outbound rows had FIFO refreshed at that time."
                          />
                        }
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
                      <Route path="/reports/stock-comparison" element={<StockComparisonReport />} />
                      <Route path="/sap-stock" element={<SapStock />} />
                      <Route path="/godam-plugin" element={<Navigate to="/dashboard" replace />} />
                      <Route path="/puter-tools" element={<PuterTools />} />
                      <Route
                        path="/huawei-godam"
                        element={
                          <UnderConstruction
                            title="Huawei · Upload files"
                            detail="GoDam Huawei uploads and matching are under construction. OCR / large PDF tooling is paused here as well."
                          />
                        }
                      />
                      <Route path="/main-stock" element={<MainStock />} />
                      <Route path="/stock-by-rack/*" element={<StockByRack currentUser={user} />} />
                      <Route path="/pick-suggestion" element={<Navigate to="/dashboard" replace />} />
                      <Route path="/outbound-pick" element={<OutboundUpload currentUser={user} />} />
                      <Route path="/outbound-upload" element={<Navigate to="/outbound-pick" replace />} />
                      <Route path="/picked-orders" element={<Navigate to="/outbound-pick" replace />} />
                      <Route path="/customers" element={<Customers />} />
                      <Route path="/delivery-note" element={<DeliveryNote />} />
                      <Route path="/sales-order-documents" element={<SalesOrderDocuments />} />
                      <Route path="/pod-inbox" element={<PodInbox />} />
                      <Route path="/carrier-master" element={<Navigate to="/transportation-details" replace />} />
                      <Route path="/transportation-details" element={<TransportationDetails user={user} />} />
                      <Route path="/vendor-master" element={<VendorMaster />} />
                      <Route path="/vendor-items" element={<VendorItems />} />
                      <Route path="/users" element={<UsersAdmin />} />
                      <Route path="/warehouses" element={<WarehousesAdmin />} />
                      <Route path="/role-permissions" element={<RolePermissions />} />
                      <Route path="/pick-change-requests" element={<PickChangeRequests />} />
                      <Route path="/admin-bom-parts" element={<AdminBomParts />} />
                      <Route
                        path="/mobile-apps"
                        element={
                          <RequireAdmin user={user}>
                            <MobileApps />
                          </RequireAdmin>
                        }
                      />
                      <Route path="/notifications" element={<Notifications />} />
                      <Route path="/" element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                  </main>
                </div>
                <FloatingAIAgent user={user} />
              </div>
              </CardDisplayProvider>
              </WarehouseProvider>
            </RequireAuth>
          }
        />
      </Routes>
      </ThemeProvider>
    </Router>
  );
}

export default App;
