import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Layers } from 'lucide-react';
import StockByRackSummary from './StockByRackSummary';
import StockIn from './StockIn';
import StockOut from './StockOut';

const tabClass = ({ isActive }) =>
  `px-2 py-1 rounded-md text-[11px] font-bold transition-all border ${
    isActive ? 'bg-primary-50 text-primary-700 border-primary-200' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
  }`;

const StockByRack = ({ currentUser }) => {
  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-start justify-between mb-2 gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-900 leading-tight">Stock By Rack</h2>
          <p className="text-[11px] text-gray-600">Summary / Stock In / Stock Out</p>
        </div>
        <div className="hidden md:flex items-center gap-1 text-[10px] font-semibold text-gray-500">
          <Layers size={12} />
          Rack availability
        </div>
      </div>

      {/* Tabs */}
      <div className="app-page-toolbar flex flex-wrap gap-1">
        <NavLink to="/stock-by-rack/summary" className={tabClass}>
          Summary
        </NavLink>
        <NavLink to="/stock-by-rack/stock-in" className={tabClass}>
          Stock In
        </NavLink>
        <NavLink to="/stock-by-rack/stock-out" className={tabClass}>
          Stock Out
        </NavLink>
      </div>

      <Routes>
        <Route path="/" element={<Navigate to="summary" replace />} />
        <Route path="summary" element={<StockByRackSummary currentUser={currentUser} />} />
        <Route path="stock-in" element={<StockIn />} />
        <Route path="stock-out" element={<StockOut />} />
      </Routes>
    </div>
  );
};

export default StockByRack;
