import { useEffect, useState } from 'react';
import api from '../services/api';
import { BarChart3, Package, Layers, Truck, AlertCircle } from 'lucide-react';

const Dashboard = () => {
  const [stats, setStats] = useState({
    total_skus: 0,
    total_available_qty: 0,
    low_stock_count: 0,
    pending_outbound: 0
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardStats();
  }, []);

  const fetchDashboardStats = async () => {
    try {
      setLoading(true);
      const [mainStockRes, rackRes, outboundRes] = await Promise.all([
        api.get('/main-stock', { params: { limit: 1000 } }),
        api.get('/stock-by-rack', { params: { available_only: true, limit: 1000 } }),
        api.get('/outbound')
      ]);

      const mainStock = mainStockRes.data;
      const racks = rackRes.data;
      const outbounds = outboundRes.data;

      setStats({
        total_skus: mainStock.length,
        total_available_qty: mainStock.reduce((sum, item) => sum + (item.available_qty || 0), 0),
        low_stock_count: mainStock.filter(item => (item.available_qty || 0) < 10).length,
        pending_outbound: outbounds.filter((o) => {
          const st = String(o.status || '').toLowerCase();
          return ['pending', 'uploaded', 'stock checked', 'sent for pick'].includes(st);
        }).length
      });
    } catch (error) {
      console.error('Dashboard stats error:', error);
    } finally {
      setLoading(false);
    }
  };

  const StatsCard = ({ title, value, icon: Icon, color = 'primary', change = 0 }) => (
    <div className="bg-white p-2.5 rounded-lg shadow-sm border border-gray-200 hover:shadow-sm transition-all">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-bold text-gray-600 uppercase tracking-wide">{title}</p>
          <p className="mt-0.5 text-lg font-bold text-gray-900 leading-tight">{value}</p>
          {change !== 0 && (
            <p className={`text-[11px] mt-0.5 font-semibold ${
              change >= 0 ? 'text-warehouse-green' : 'text-warehouse-red'
            }`}>
              {change >= 0 ? '+' : ''}{change}%
            </p>
          )}
        </div>
        <div className={`p-1.5 rounded-md bg-${color}-50 flex-shrink-0`}>
          <Icon className={`w-4 h-4 text-${color}-600`} />
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2">
        <h2 className="text-base font-bold text-gray-900 leading-tight">Dashboard</h2>
        <p className="text-[11px] text-gray-600">Warehouse overview and key metrics</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 mb-3">
        <StatsCard 
          title="Total SKUs" 
          value={stats.total_skus.toLocaleString()}
          icon={Package}
          color="blue"
        />
        <StatsCard 
          title="Available Qty" 
          value={Math.round(stats.total_available_qty).toLocaleString()}
          icon={Layers}
          color="green"
        />
        <StatsCard 
          title="Low Stock" 
          value={stats.low_stock_count}
          icon={AlertCircle}
          color="orange"
        />
        <StatsCard 
          title="Pending Outbound" 
          value={stats.pending_outbound}
          icon={Truck}
          color="primary"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <div className="bg-white p-3 rounded-lg shadow-sm border">
          <h3 className="text-xs font-bold text-gray-900 mb-2">Recent Activity</h3>
          <div className="text-center py-6 text-[11px] text-gray-500">
            Recent stock movements will appear here
          </div>
        </div>
        <div className="bg-white p-3 rounded-lg shadow-sm border">
          <h3 className="text-xs font-bold text-gray-900 mb-2">Quick Actions</h3>
          <div className="space-y-1.5">
            <a href="/main-stock" className="btn-primary w-full block text-center py-1.5">
              Manage Main Stock
            </a>
            <a href="/stock-by-rack" className="btn-secondary w-full block text-center py-1.5">
              Update Rack Stock
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
