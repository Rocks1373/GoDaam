import { useCallback, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Package,
  Layers,
  Truck,
  Users,
  FileText,
  FileSearch,
  FolderOpen,
  MessageCircle,
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
  Download,
  Cloud,
  MapPin,
  Bell,
} from 'lucide-react';

const ICONS = {
  LayoutGrid,
  Package,
  Layers,
  Database,
  Truck,
  UploadCloud,
  FileText,
  FileSearch,
  Image,
  FolderOpen,
  MessageCircle,
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
  Download,
  Cloud,
  MapPin,
  Bell,
};

function NavDropdownLink({ to, end, icon, label, disabled, title, onClick }) {
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
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="app-topnav-dropdown-link w-full text-left"
        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
      >
        {Icon ? <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden /> : null}
        <span className="truncate">{label}</span>
      </button>
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

export default function AppTopNav({ user }) {
  const location = useLocation();
  const [openGroupId, setOpenGroupId] = useState(null);
  const [mobileGroup, setMobileGroup] = useState(null);

  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
  const role = String(user?.role || '').toLowerCase();
  const canOutboundUpload =
    isAdmin ||
    role === 'manager' ||
    role === 'checker' ||
    user?.permissions?.can_upload_outbound ||
    user?.permissions?.can_confirm_picked;
  const canOutboundView =
    canOutboundUpload ||
    user?.permissions?.can_view_picked_table ||
    user?.permissions?.can_view_delivery_notes ||
    user?.permissions?.can_download_documents;
  const canPodInbox =
    canOutboundView ||
    user?.permissions?.can_view_document_center ||
    user?.permissions?.can_view_orders;
  const canUseWhatsappMessenger = isAdmin || user?.permissions?.can_use_whatsapp_messenger;
  const canOrderPickStatus = isAdmin || user?.permissions?.can_view_order_pick_status;
  const canViewHuawei = isAdmin || user?.permissions?.can_view_huawei || user?.permissions?.can_huawei_view;
  const canViewDriverGps =
    isAdmin ||
    user?.permissions?.can_view_driver_gps ||
    user?.permissions?.can_view_transportation ||
    user?.permissions?.can_manage_transportation ||
    user?.permissions?.can_confirm_picked;
  const canViewFollowups =
    isAdmin || user?.permissions?.can_view_followups || user?.permissions?.can_manage_followups;

  const closeGroup = useCallback(() => {
    setOpenGroupId(null);
  }, []);

  const openGroup = useCallback((id) => {
    setOpenGroupId(id);
  }, []);

  useEffect(() => {
    setOpenGroupId(null);
    setMobileGroup(null);
  }, [location.pathname]);

  const isPathActive = (prefixes) =>
    prefixes.some((p) => location.pathname === p || location.pathname.startsWith(`${p}/`));

  const stockActive = isPathActive(['/main-stock', '/stock-by-rack']);
  const followupsActive = isPathActive(['/follow-ups']);
  const shipmentsActive = isPathActive([
    '/shipments/create',
    '/shipments/upcoming',
    '/shipments/receive',
    '/shipments/received',
  ]);
  const canManageShipments = isAdmin || role === 'manager';
  const canReceiveShipments =
    canManageShipments || user?.permissions?.can_receive_stock;
  const sapActive = isPathActive(['/sap', '/sap-stock']);
  const deliveryNoteActive = isPathActive(['/delivery-note']);
  const documentFlowActive = location.pathname.startsWith('/document-flow');
  const deliveryActive = isPathActive([
    '/outbound-pick',
    '/order-pick-status',
    '/pod-inbox',
    '/pod-page-picker',
    '/sales-order-documents',
    '/document-query',
    '/driver-gps',
  ]);
  const masterActive = isPathActive(['/customers', '/transportation-details', '/vendor-master', '/vendor-items']);
  const reportsActive = location.pathname.startsWith('/reports/');
  const huaweiActive = isPathActive(['/huawei']);
  const matchingActive = isPathActive(['/matching']);
  const adminActive = isPathActive([
    '/users',
    '/access-requests',
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
    ...(canViewFollowups
      ? [
          {
            id: 'follow-ups',
            label: 'Follow-Ups',
            active: followupsActive,
            single: { to: '/follow-ups', icon: 'Bell', label: 'Follow-Ups' },
          },
        ]
      : []),
    {
      id: 'delivery-note',
      label: 'Delivery Note',
      active: deliveryNoteActive,
      single: { to: '/delivery-note', icon: 'FileText', label: 'Delivery Note' },
    },
    {
      id: 'document-flow',
      label: 'Document Flow',
      active: documentFlowActive,
      single: { to: '/document-flow', icon: 'FolderOpen', label: 'Document Flow' },
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
      ],
    },
    ...(canReceiveShipments || canManageShipments
      ? [
          {
            id: 'shipments',
            label: 'Shipments',
            active: shipmentsActive,
            sections: [
              {
                links: [
                  ...(canManageShipments
                    ? [{ to: '/shipments/create', icon: 'UploadCloud', label: 'Create Shipment' }]
                    : []),
                  { to: '/shipments/upcoming', icon: 'Truck', label: 'Upcoming Shipments' },
                  ...(canReceiveShipments
                    ? [{ to: '/shipments/receive', icon: 'LogIn', label: 'Receive Shipment' }]
                    : []),
                  { to: '/shipments/received', icon: 'Package', label: 'Received Shipments' },
                ],
              },
            ],
          },
        ]
      : []),
    {
      id: 'sap',
      label: 'SAP',
      active: sapActive,
      sections: [
        {
          links: [
            { to: '/sap/sap-stock', icon: 'Database', label: 'SAP Stock' },
            { to: '/sap/sap-po', icon: 'FileSpreadsheet', label: 'SAP PO and SO' },
          ],
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
            ...(canOutboundUpload
              ? [{ to: '/outbound-pick', icon: 'UploadCloud', label: 'Outbound & pick' }]
              : []),
            ...(canOrderPickStatus
              ? [{ to: '/order-pick-status', icon: 'ClipboardPenLine', label: 'Order pick status' }]
              : []),
            ...(canPodInbox ? [{ to: '/pod-inbox', icon: 'Image', label: 'POD inbox' }] : []),
            ...(canOutboundUpload || user?.permissions?.can_view_pod_page_picker
              ? [{ to: '/pod-page-picker', icon: 'FileText', label: 'POD Page Picker' }]
              : []),
            ...(canViewDriverGps ? [{ to: '/driver-gps', icon: 'MapPin', label: 'Driver GPS' }] : []),
            ...(canUseWhatsappMessenger
              ? [{ to: '/whatsapp-messenger', icon: 'MessageCircle', label: 'WhatsApp Messenger' }]
              : []),
            { to: '/document-workflow', icon: 'FolderOpen', label: 'Document Workflow' },
            { to: '/document-query', icon: 'FileSearch', label: 'Document Query' },
            { to: '/download-duties', icon: 'Download', label: 'Download Duties' },
            { to: '/sales-order-documents', icon: 'FolderOpen', label: 'Document Center' },
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
            { to: '/reports/document-workflow', icon: 'FolderOpen', label: 'Document Workflow Report' },
            { to: '/reports/stock-by-rack-report', icon: 'Layers', label: 'Stock By Rack Report' },
            { to: '/reports/rack-balance-adjustments', icon: 'ClipboardPenLine', label: 'Rack adjustments' },
            { to: '/reports/rack-update', icon: 'Layers', label: 'Rack Update Report' },
            { to: '/reports/picking-by-rack', icon: 'ClipboardPenLine', label: 'Picking By Rack' },
            ...(canOrderPickStatus
              ? [{ to: '/reports/order-pick-status', icon: 'ClipboardPenLine', label: 'Order Pick Status' }]
              : []),
            { to: '/reports/main-stock-report', icon: 'Package', label: 'Main Stock Report' },
            { to: '/reports/stock-comparison', icon: 'GitCompare', label: 'Stock Comparison' },
          ],
        },
      ],
    },
    ...(canViewHuawei
      ? [
          {
            id: 'matching',
            label: 'Matching',
            active: matchingActive,
            single: { to: '/matching', icon: 'GitCompare', label: 'Matching' },
          },
          {
            id: 'huawei',
            label: 'Huawei Order 2.1',
            active: huaweiActive,
            single: { to: '/huawei', icon: 'GitCompare', label: 'Huawei Order 2.1' },
          },
        ]
      : []),
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
                  { to: '/access-requests', icon: 'KeySquare', label: 'Access requests' },
                  { to: '/warehouses', icon: 'Warehouse', label: 'Warehouses' },
                  { to: '/role-permissions', icon: 'KeySquare', label: 'Role Permissions' },
                  { to: '/pick-change-requests', icon: 'Truck', label: 'Pick Requests' },
                  { to: '/admin-bom-parts', icon: 'Boxes', label: 'Parent & Child Parts' },
                  { to: '/mobile-apps', icon: 'Smartphone', label: 'Mobile Apps' },
                  { to: '/settings/google-drive', icon: 'Cloud', label: 'Google Drive' },
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
    <div className="app-topnav-zone">
      <nav className="app-topnav" aria-label="Main navigation">
        <ul className="app-topnav__list">
          {groups.map((group) => {
            const isOpen = openGroupId === group.id || mobileGroup === group.id;
            return (
              <li
                key={group.id}
                className={`app-topnav__item${group.active ? ' app-topnav__item--active' : ''}${
                  isOpen ? ' app-topnav__item--open' : ''
                }${mobileGroup === group.id ? ' app-topnav__item--mobile-open' : ''}`}
                onPointerEnter={() => {
                  if (!group.single) openGroup(group.id);
                }}
                onPointerLeave={() => {
                  if (!group.single) closeGroup();
                }}
              >
                {group.single ? (
                  <NavLink
                    to={group.single.to}
                    end
                    className={({ isActive }) =>
                      `app-topnav__trigger app-topnav__trigger--solo${isActive ? ' app-topnav__trigger--active' : ''}`
                    }
                  >
                    {(() => {
                      const SoloIcon = ICONS[group.single.icon] || LayoutGrid;
                      return <SoloIcon className="w-3.5 h-3.5" aria-hidden />;
                    })()}
                    {group.label}
                  </NavLink>
                ) : (
                  <>
                    <button
                      type="button"
                      className={`app-topnav__trigger${group.active ? ' app-topnav__trigger--active' : ''}`}
                      aria-expanded={isOpen}
                      aria-haspopup="true"
                      onClick={() =>
                        setMobileGroup((g) => (g === group.id ? null : group.id))
                      }
                    >
                      {group.id === 'stock' ? <Package className="w-3.5 h-3.5" aria-hidden /> : null}
                      {group.id === 'sap' ? <Database className="w-3.5 h-3.5" aria-hidden /> : null}
                      {group.id === 'delivery' ? <Truck className="w-3.5 h-3.5" aria-hidden /> : null}
                      {group.id === 'master' ? <Warehouse className="w-3.5 h-3.5" aria-hidden /> : null}
                      {group.id === 'reports' ? <PieChart className="w-3.5 h-3.5" aria-hidden /> : null}
                      {group.id === 'plugins' ? <Construction className="w-3.5 h-3.5" aria-hidden /> : null}
                      {group.id === 'admin' ? <ShieldCheck className="w-3.5 h-3.5" aria-hidden /> : null}
                      <span>{group.label}</span>
                    </button>
                    <div
                      className="app-topnav__dropdown"
                      role="menu"
                      onPointerEnter={() => openGroup(group.id)}
                      onPointerLeave={() => closeGroup()}
                    >
                      {renderDropdown(group)}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
