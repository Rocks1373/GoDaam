import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Package,
  Layers,
  Truck,
  Users,
  FileText,
  FolderOpen,
  UploadCloud,
  KeySquare,
  ShieldCheck,
  UserCog,
  Database,
  PieChart,
  LineChart,
  FileSpreadsheet,
  Image,
  GitCompare,
  ClipboardPenLine,
  Boxes,
  Smartphone,
  Construction,
  Warehouse,
  LayoutGrid,
  ScrollText,
  LogIn,
  LogOut as LogOutIcon,
} from 'lucide-react';

const ICONS = {
  LayoutGrid,
  Package,
  Layers,
  Database,
  Truck,
  UploadCloud,
  FileText,
  Image,
  FolderOpen,
  Users,
  Boxes,
  PieChart,
  LineChart,
  FileSpreadsheet,
  ScrollText,
  GitCompare,
  ClipboardPenLine,
  Construction,
  ShieldCheck,
  UserCog,
  Warehouse,
  KeySquare,
  Smartphone,
  LogIn,
  LogOut: LogOutIcon,
};

function NavDropdownLink({ to, end, icon, label, disabled, title }) {
  const Icon = icon ? ICONS[icon] : null;
  if (disabled) {
    return (
      <span
        className="app-topnav-dropdown-link app-topnav-dropdown-link--disabled"
        title={title || 'Under construction'}
        aria-disabled="true"
      >
        {Icon ? <Icon className="w-3.5 h-3.5 flex-shrink-0 opacity-70" aria-hidden /> : null}
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `app-topnav-dropdown-link${isActive ? ' app-topnav-dropdown-link--active' : ''}`
      }
    >
      {Icon ? <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden /> : null}
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function NavDropdownSection({ title, children }) {
  if (!children?.length) return null;
  return (
    <div className="app-topnav-dropdown-section">
      {title ? <div className="app-topnav-dropdown-section__title">{title}</div> : null}
      <div className="app-topnav-dropdown-section__links">{children}</div>
    </div>
  );
}

/** Auto-hide top nav dropdowns after this idle time (ms). */
const TOPNAV_AUTO_HIDE_MS = 5000;

/** Top navigation: categories in header; sub-links appear when pointer enters the nav zone. */
export default function AppTopNav({ user }) {
  const location = useLocation();
  const zoneRef = useRef(null);
  const [navOpen, setNavOpen] = useState(false);
  const [mobileGroup, setMobileGroup] = useState(null);
  const collapseTimer = useRef(null);

  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
  const canOutbound =
    isAdmin || user?.permissions?.can_upload_outbound || user?.permissions?.can_view_picked_table;

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimer.current != null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }, []);

  const scheduleCollapse = useCallback(() => {
    clearCollapseTimer();
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = null;
      if (zoneRef.current?.contains(document.activeElement)) return;
      setNavOpen(false);
      setMobileGroup(null);
    }, TOPNAV_AUTO_HIDE_MS);
  }, [clearCollapseTimer]);

  useEffect(() => () => clearCollapseTimer(), [clearCollapseTimer]);

  useEffect(() => {
    setNavOpen(false);
    setMobileGroup(null);
    clearCollapseTimer();
  }, [location.pathname, clearCollapseTimer]);

  const onZoneEnter = useCallback(() => {
    clearCollapseTimer();
    setNavOpen(true);
    scheduleCollapse();
  }, [clearCollapseTimer, scheduleCollapse]);

  const onZoneLeave = useCallback(() => {
    scheduleCollapse();
  }, [scheduleCollapse]);

  const onZoneActivity = useCallback(() => {
    if (!navOpen) return;
    scheduleCollapse();
  }, [navOpen, scheduleCollapse]);

  const isPathActive = (prefixes) =>
    prefixes.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`));

  const stockActive = isPathActive(['/main-stock', '/stock-by-rack', '/sap-stock']);
  const deliveryActive = isPathActive([
    '/outbound-pick',
    '/delivery-note',
    '/pod-inbox',
    '/sales-order-documents',
  ]);
  const masterActive = isPathActive(['/customers', '/transportation-details', '/vendor-master', '/vendor-items']);
  const reportsActive = location.pathname.startsWith('/reports/');
  const pluginsActive = isPathActive(['/huawei-godam', '/puter-tools', '/godam-plugin']);
  const adminActive = isPathActive([
    '/users',
    '/warehouses',
    '/role-permissions',
    '/pick-change-requests',
    '/admin-bom-parts',
    '/mobile-apps',
  ]);

  const groups = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      active: location.pathname === '/dashboard',
      single: { to: '/dashboard', icon: 'LayoutGrid', label: 'Dashboard' },
    },
    {
      id: 'stock',
      label: 'Stock',
      active: stockActive,
      sections: [
        {
          title: 'Main stock',
          links: [{ to: '/main-stock', icon: 'Package', label: 'Main Stock' }],
        },
        {
          title: 'Stock by rack',
          links: [
            { to: '/stock-by-rack/summary', icon: 'Layers', label: 'Rack summary' },
            { to: '/stock-by-rack/stock-in', icon: 'LogIn', label: 'Stock In' },
            { to: '/stock-by-rack/stock-out', icon: 'LogOut', label: 'Stock Out' },
          ],
        },
        {
          title: 'SAP',
          links: [{ to: '/sap-stock', icon: 'Database', label: 'SAP Stock' }],
        },
      ],
    },
    {
      id: 'delivery',
      label: 'Delivery',
      active: deliveryActive,
      sections: [
        {
          links: [
            ...(canOutbound
              ? [{ to: '/outbound-pick', icon: 'UploadCloud', label: 'Outbound & pick' }]
              : []),
            { to: '/delivery-note', icon: 'FileText', label: 'Delivery Note' },
            { to: '/pod-inbox', icon: 'Image', label: 'POD inbox' },
            { to: '/sales-order-documents', icon: 'FolderOpen', label: 'Sales Order Documents' },
          ],
        },
      ],
    },
    {
      id: 'master',
      label: 'Master',
      active: masterActive,
      sections: [
        {
          links: [
            { to: '/customers', icon: 'Users', label: 'Customers' },
            { to: '/transportation-details', icon: 'Truck', label: 'Transportation' },
            { to: '/vendor-master', icon: 'Boxes', label: 'Vendor Master' },
            { to: '/vendor-items', icon: 'Package', label: 'Vendor Items' },
          ],
        },
      ],
    },
    {
      id: 'reports',
      label: 'Reports',
      active: reportsActive,
      sections: [
        {
          links: [
            { to: '/reports/inbound', icon: 'Truck', label: 'Inbound Report' },
            { to: '/reports/outbound', icon: 'LineChart', label: 'Outbound Report' },
            { to: '/reports/delivery', icon: 'FileSpreadsheet', label: 'Delivery Report' },
            { to: '/reports/audit-log', icon: 'ScrollText', label: 'Audit Log' },
            { to: '/reports/sales-order-documents', icon: 'FolderOpen', label: 'SO Documents Report' },
            { to: '/reports/stock-by-rack-report', icon: 'Layers', label: 'Stock By Rack Report' },
            { to: '/reports/rack-balance-adjustments', icon: 'ClipboardPenLine', label: 'Rack adjustments' },
            { to: '/reports/main-stock-report', icon: 'Package', label: 'Main Stock Report' },
            { to: '/reports/stock-comparison', icon: 'GitCompare', label: 'Stock Comparison' },
          ],
        },
      ],
    },
    {
      id: 'plugins',
      label: 'Plugins',
      active: pluginsActive,
      sections: [
        {
          links: [
            { disabled: true, icon: 'Boxes', label: 'GoDam 1.0' },
            { disabled: true, icon: 'Image', label: 'OCR — large PDFs' },
            { to: '/huawei-godam', icon: 'UploadCloud', label: 'Huawei upload' },
            { to: '/puter-tools', icon: 'Construction', label: 'Puter · AI / OCR' },
          ],
        },
      ],
    },
    ...(isAdmin
      ? [
          {
            id: 'admin',
            label: 'Admin',
            active: adminActive,
            sections: [
              {
                links: [
                  { to: '/users', icon: 'UserCog', label: 'Users' },
                  { to: '/warehouses', icon: 'Warehouse', label: 'Warehouses' },
                  { to: '/role-permissions', icon: 'KeySquare', label: 'Role Permissions' },
                  { to: '/pick-change-requests', icon: 'Truck', label: 'Pick Requests' },
                  { to: '/admin-bom-parts', icon: 'Boxes', label: 'Parent & Child Parts' },
                  { to: '/mobile-apps', icon: 'Smartphone', label: 'Mobile Apps' },
                ],
              },
            ],
          },
        ]
      : []),
  ];

  const renderDropdown = (group) => {
    if (group.single) {
      return (
        <NavDropdownLink
          to={group.single.to}
          end
          icon={group.single.icon}
          label={group.single.label}
        />
      );
    }
    return (group.sections || []).map((section, si) => (
      <NavDropdownSection key={`${group.id}-${si}`} title={section.title}>
        {(section.links || []).map((link) => (
          <NavDropdownLink key={link.to || link.label} {...link} />
        ))}
      </NavDropdownSection>
    ));
  };

  return (
    <div
      ref={zoneRef}
      className={`app-topnav-zone${navOpen ? ' app-topnav-zone--open' : ''}`}
      onPointerEnter={onZoneEnter}
      onPointerLeave={onZoneLeave}
      onPointerMove={onZoneActivity}
      onFocusCapture={() => {
        clearCollapseTimer();
        setNavOpen(true);
        scheduleCollapse();
      }}
      onBlurCapture={(e) => {
        const next = e.relatedTarget;
        if (zoneRef.current && next instanceof Node && zoneRef.current.contains(next)) return;
        scheduleCollapse();
      }}
    >
      <nav className="app-topnav" aria-label="Main navigation">
        <ul className="app-topnav__list">
          {groups.map((group) => (
            <li
              key={group.id}
              className={`app-topnav__item${group.active ? ' app-topnav__item--active' : ''}${
                mobileGroup === group.id ? ' app-topnav__item--mobile-open' : ''
              }`}
            >
              {group.single ? (
                <NavLink
                  to={group.single.to}
                  end
                  className={({ isActive }) =>
                    `app-topnav__trigger app-topnav__trigger--solo${isActive ? ' app-topnav__trigger--active' : ''}`
                  }
                >
                  <LayoutGrid className="w-3.5 h-3.5" aria-hidden />
                  {group.label}
                </NavLink>
              ) : (
                <>
                  <button
                    type="button"
                    className={`app-topnav__trigger${group.active ? ' app-topnav__trigger--active' : ''}`}
                    aria-expanded={navOpen || mobileGroup === group.id}
                    aria-haspopup="true"
                    onClick={() =>
                      setMobileGroup((g) => (g === group.id ? null : group.id))
                    }
                  >
                    {group.id === 'stock' ? <Package className="w-3.5 h-3.5" aria-hidden /> : null}
                    {group.id === 'delivery' ? <Truck className="w-3.5 h-3.5" aria-hidden /> : null}
                    {group.id === 'master' ? <Warehouse className="w-3.5 h-3.5" aria-hidden /> : null}
                    {group.id === 'reports' ? <PieChart className="w-3.5 h-3.5" aria-hidden /> : null}
                    {group.id === 'plugins' ? <Construction className="w-3.5 h-3.5" aria-hidden /> : null}
                    {group.id === 'admin' ? <ShieldCheck className="w-3.5 h-3.5" aria-hidden /> : null}
                    <span>{group.label}</span>
                  </button>
                  <div className="app-topnav__dropdown" role="menu">
                    {renderDropdown(group)}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </nav>
      {!navOpen ? (
        <p className="app-topnav-hint hidden lg:block" aria-hidden>
          Hover for menu · auto-hide 5s
        </p>
      ) : null}
    </div>
  );
}
