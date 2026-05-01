import { useEffect, useMemo, useState } from 'react';
import { Download, Filter, Search } from 'lucide-react';
import * as XLSX from 'xlsx';
import { stockByRackApi } from '../services/api';

const StockByRackSummary = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [partNumber, setPartNumber] = useState('');
  const [sapPn, setSapPn] = useState('');
  const [rack, setRack] = useState('');
  const [availableOnly, setAvailableOnly] = useState(true);

  const params = useMemo(
    () => ({
      part_number: partNumber || undefined,
      sap_part_number: sapPn || undefined,
      rack_location: rack || undefined,
      available_only: availableOnly ? 'true' : 'false',
      limit: 500,
    }),
    [partNumber, sapPn, rack, availableOnly]
  );

  const fetchRows = async () => {
    try {
      setLoading(true);
      const data = await stockByRackApi.list(params);
      setRows(data || []);
    } catch (e) {
      console.error('Failed loading stock by rack summary:', e);
      alert('Failed to load summary: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  };

  // Debounce filter inputs so typing stays smooth.
  useEffect(() => {
    const t = setTimeout(() => {
      fetchRows();
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.part_number, params.sap_part_number, params.rack_location, params.available_only]);

  const exportExcel = () => {
    const exportRows = (rows || []).map((r) => ({
      part_number: r.part_number,
      sap_part_number: r.sap_part_number,
      description: r.description,
      rack_location: r.rack_location,
      total_in_qty: r.total_in_qty,
      total_out_qty: r.total_out_qty,
      available_qty: r.available_qty,
      first_entry_date: r.first_entry_date,
      last_updated: r.last_updated,
    }));
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock By Rack Summary');
    XLSX.writeFile(wb, 'stock-by-rack-summary.xlsx');
  };

  const exportCsv = () => {
    const exportRows = (rows || []).map((r) => ({
      part_number: r.part_number,
      sap_part_number: r.sap_part_number,
      description: r.description,
      rack_location: r.rack_location,
      total_in_qty: r.total_in_qty,
      total_out_qty: r.total_out_qty,
      available_qty: r.available_qty,
      first_entry_date: r.first_entry_date,
      last_updated: r.last_updated,
    }));
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const csv = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stock-by-rack-summary.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="app-page-toolbar">
        <div className="flex flex-col lg:flex-row gap-2 lg:items-end">
          <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>
              <div className="text-[10px] font-bold text-gray-600 mb-0.5">Part Number</div>
              <div className="flex items-center gap-1.5">
                <Search size={14} className="text-gray-400 flex-shrink-0" />
                <input
                  className="input-field flex-1"
                  value={partNumber}
                  onChange={(e) => setPartNumber(e.target.value)}
                  placeholder="Search part number..."
                />
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold text-gray-600 mb-0.5">SAP PN</div>
              <div className="flex items-center gap-1.5">
                <Search size={14} className="text-gray-400 flex-shrink-0" />
                <input
                  className="input-field flex-1"
                  value={sapPn}
                  onChange={(e) => setSapPn(e.target.value)}
                  placeholder="Search SAP PN..."
                />
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold text-gray-600 mb-0.5">Rack Location</div>
              <div className="flex items-center gap-1.5">
                <Search size={14} className="text-gray-400 flex-shrink-0" />
                <input
                  className="input-field flex-1"
                  value={rack}
                  onChange={(e) => setRack(e.target.value)}
                  placeholder="Search rack..."
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <label className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-700">
              <Filter size={14} className="text-gray-400 flex-shrink-0" />
              <input
                type="checkbox"
                checked={availableOnly}
                onChange={(e) => setAvailableOnly(e.target.checked)}
              />
              Available only
            </label>
            <button type="button" className="btn-secondary flex items-center gap-1" onClick={exportCsv}>
              <Download size={14} />
              Export CSV
            </button>
            <button type="button" className="btn-secondary flex items-center gap-1" onClick={exportExcel}>
              <Download size={14} />
              Export Excel
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div>Loading summary…</div>
      ) : (
        <div className="table-container">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="tbl-th">
                  Part Number
                </th>
                <th className="tbl-th">
                  SAP PN
                </th>
                <th className="tbl-th">
                  Description
                </th>
                <th className="tbl-th">
                  Rack Location
                </th>
                <th className="tbl-th">
                  Total In Qty
                </th>
                <th className="tbl-th">
                  Total Out Qty
                </th>
                <th className="tbl-th">
                  Available Qty
                </th>
                <th className="tbl-th">
                  First Entry Date
                </th>
                <th className="tbl-th">
                  Last Updated
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(rows || []).map((r) => (
                <tr key={`${r.part_number}-${r.rack_location}`} className="hover:bg-gray-50">
                  <td className="tbl-td-nowrap">{r.part_number}</td>
                  <td className="tbl-td-nowrap">{r.sap_part_number || '-'}</td>
                  <td className="tbl-td">{r.description || '-'}</td>
                  <td className="tbl-td-nowrap">{r.rack_location}</td>
                  <td className="tbl-td-nowrap">{r.total_in_qty ?? 0}</td>
                  <td className="tbl-td-nowrap">{r.total_out_qty ?? 0}</td>
                  <td className="tbl-td-nowrap">{r.available_qty ?? 0}</td>
                  <td className="tbl-td-nowrap">
                    {r.first_entry_date ? String(r.first_entry_date).slice(0, 10) : '-'}
                  </td>
                  <td className="tbl-td-nowrap">
                    {r.last_updated ? String(r.last_updated).slice(0, 19).replace('T', ' ') : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default StockByRackSummary;

