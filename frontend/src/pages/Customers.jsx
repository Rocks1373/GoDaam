import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Edit3, Plus, Search, Trash2, Upload, Eye } from 'lucide-react';
import * as XLSX from 'xlsx';
import { customersApi } from '../services/api';
import { useTableSort } from '../hooks/useTableSort';
import SortTh from '../components/SortTh';

/** Column keys matching EXCEL_HEADERS order (for sort) */
const CUSTOMER_COL_KEYS = [
  'customer_number',
  'company_name',
  'city_name',
  'address',
  'gps',
  'contact_person',
  'contact_person_number',
  'email_1',
  'designation_job',
  'second_name',
  'second_number',
  'second_email',
  'designation_job_2',
  'remarks',
];

const EXCEL_HEADERS = [
  'Customer Number',
  'Company Name',
  'City Name',
  'Address',
  'GPS',
  'Contact Person',
  'Contact Person Number',
  'Email 1',
  'Designation / Job',
  '2nd Name',
  '2nd Number',
  '2nd Email',
  'Designation / Job 2',
  'Remarks',
];

export default function Customers() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({
    customer_number: '',
    company_name: '',
    city_name: '',
    address: '',
    gps: '',
    contact_person: '',
    contact_person_number_1: '',
    email_1: '',
    designation_job: '',
    second_name: '',
    second_number: '',
    second_email: '',
    designation_job_title_2: '',
    remarks: '',
    address_type: 'permanent', // permanent | temporary
  });

  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);

  const fileRef = useRef(null);

  const fetchRows = async (q = '') => {
    try {
      setLoading(true);
      const data = await customersApi.list(q);
      setRows(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRows('');
  }, []);

  // Debounce search so you can type full values smoothly.
  useEffect(() => {
    const t = setTimeout(() => {
      fetchRows(search);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const parseBulk = () => {
    const lines = bulkData.trim().split('\n').filter((l) => l.trim());
    return lines.map((line) => {
      const c = line.split('\t');
      return {
        customer_number: c[0],
        company_name: c[1],
        city_name: c[2],
        address: c[3],
        gps: c[4],
        contact_person: c[5],
        contact_person_number: c[6],
        email_1: c[7],
        designation_job: c[8],
        second_name: c[9],
        second_number: c[10],
        second_email: c[11],
        designation_job_2: c[12],
        remarks: c[13],
      };
    });
  };

  const previewBulk = () => setBulkPreview(parseBulk().slice(0, 20));

  const importBulk = async () => {
    try {
      const data = parseBulk();
      await customersApi.bulkPaste(data);
      setShowBulkModal(false);
      setBulkData('');
      setBulkPreview([]);
      fetchRows(search);
    } catch (e) {
      alert('Bulk import failed: ' + (e?.response?.data?.error || e.message));
    }
  };

  const onUploadFile = async (file) => {
    try {
      await customersApi.upload(file);
      fetchRows(search);
    } catch (e) {
      alert('Upload failed: ' + (e?.response?.data?.error || e.message));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const resetAddForm = () => {
    setAddForm({
      customer_number: '',
      company_name: '',
      city_name: '',
      address: '',
      gps: '',
      contact_person: '',
      contact_person_number_1: '',
      email_1: '',
      designation_job: '',
      second_name: '',
      second_number: '',
      second_email: '',
      designation_job_title_2: '',
      remarks: '',
      address_type: 'permanent',
    });
  };

  const createCustomerRow = async () => {
    try {
      if (!String(addForm.customer_number || '').trim()) return alert('Customer Number is required');
      if (!String(addForm.company_name || '').trim()) return alert('Company Name is required');

      await customersApi.create({
        customer_number: addForm.customer_number,
        company_name: addForm.company_name,
        city_name: addForm.city_name,
        address: addForm.address,
        gps: addForm.gps,
        contact_person: addForm.contact_person,
        contact_person_number_1: addForm.contact_person_number_1,
        contact_person_number: addForm.contact_person_number_1,
        email_1: addForm.email_1,
        designation_job: addForm.designation_job,
        second_name: addForm.second_name,
        second_number: addForm.second_number,
        second_email: addForm.second_email,
        designation_job_title_2: addForm.designation_job_title_2,
        designation_job_2: addForm.designation_job_title_2,
        remarks: addForm.remarks,
        address_type: addForm.address_type,
      });
      setShowAddModal(false);
      resetAddForm();
      fetchRows(search);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    }
  };

  const downloadTemplate = () => {
    const row = {
      'Customer Number': '120933',
      'Company Name': 'Durrah Aghizat Alhaseb Company',
      'City Name': 'Riyadh',
      Address: 'King Saud University',
      GPS: 'https://maps.app.goo.gl/example',
      'Contact Person': 'Noorah AlKhelwi',
      'Contact Person Number': '+966539645442',
      'Email 1': 'noorah@example.com',
      'Designation / Job': 'Warehouse Contact',
      '2nd Name': 'Saeed Al Farej',
      '2nd Number': '+966555093620',
      '2nd Email': 'saeed@example.com',
      'Designation / Job 2': 'Manager',
      Remarks: 'Main customer',
    };

    const ws = XLSX.utils.json_to_sheet([row], { header: EXCEL_HEADERS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Customer Address Book');
    XLSX.writeFile(wb, 'customer-address-book-template.xlsx');
  };

  const tableRows = useMemo(() => rows || [], [rows]);
  const { displayRows, sortKey, direction, requestSort } = useTableSort(tableRows);

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-start justify-between mb-2 gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-900 leading-tight">Customer Address Book</h2>
          <p className="text-[11px] text-gray-600">
            Excel upload: Customer Number and Company Name are required columns; all other columns are optional.
          </p>
        </div>
        <div className="flex gap-1.5 flex-wrap justify-end">
          <button
            type="button"
            className="btn-primary flex items-center gap-1"
            onClick={() => {
              resetAddForm();
              setShowAddModal(true);
            }}
          >
            <Plus size={14} />
            Add Customer
          </button>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={downloadTemplate}>
            <Download size={14} />
            Download Template
          </button>
          <label className="btn-secondary flex items-center gap-1 cursor-pointer">
            <Upload size={14} />
            Upload Excel/CSV
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadFile(f);
              }}
            />
          </label>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => setShowBulkModal(true)}>
            <Copy size={14} />
            Bulk Paste
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="app-page-toolbar">
        <div className="flex items-center gap-2 max-w-xl">
          <Search size={14} className="text-gray-400 flex-shrink-0" />
          <input
            type="text"
            placeholder="Search customer number, company, city, contacts, emails..."
            className="input-field flex-1"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
            }}
          />
        </div>
      </div>

      {/* Table (exact column order) */}
      <div className="table-container">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {EXCEL_HEADERS.map((h, i) => (
                <SortTh
                  key={h}
                  columnKey={CUSTOMER_COL_KEYS[i]}
                  sortKey={sortKey}
                  direction={direction}
                  onSort={requestSort}
                >
                  {h}
                </SortTh>
              ))}
              <th className="tbl-th">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={EXCEL_HEADERS.length + 1}>
                  Loading…
                </td>
              </tr>
            ) : null}
            {displayRows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="tbl-td-nowrap">{r.customer_number || ''}</td>
                <td className="tbl-td-nowrap">{r.company_name}</td>
                <td className="tbl-td-nowrap">{r.city_name || ''}</td>
                <td className="tbl-td">{r.address || ''}</td>
                <td className="tbl-td">{r.gps || ''}</td>
                <td className="tbl-td-nowrap">{r.contact_person || ''}</td>
                <td className="tbl-td-nowrap">{r.contact_person_number || ''}</td>
                <td className="tbl-td-nowrap">{r.email_1 || ''}</td>
                <td className="tbl-td-nowrap">{r.designation_job || ''}</td>
                <td className="tbl-td-nowrap">{r.second_name || ''}</td>
                <td className="tbl-td-nowrap">{r.second_number || ''}</td>
                <td className="tbl-td-nowrap">{r.second_email || ''}</td>
                <td className="tbl-td-nowrap">{r.designation_job_2 || ''}</td>
                <td className="tbl-td-nowrap">{r.remarks || ''}</td>
                <td className="tbl-td-nowrap">
                  <div className="flex gap-1">
                    <button type="button" className="text-primary-600 hover:text-primary-800 p-0.5" title="Edit (todo)">
                      <Edit3 size={14} />
                    </button>
                    <button type="button" className="text-red-600 hover:text-red-800 p-0.5" title="Delete (todo)">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!displayRows.length ? (
              <tr>
                <td className="px-2 py-3 text-xs text-gray-500" colSpan={EXCEL_HEADERS.length + 1}>
                  No customers found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Bulk Paste Modal */}
      {showBulkModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[80vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-2">Bulk Paste Customers</h3>
            <p className="text-sm text-gray-600 mb-4">
              Paste tab-separated values. At minimum provide Customer Number and Company Name (first two columns). Extra columns are optional, in template order.
            </p>
            <textarea
              value={bulkData}
              onChange={(e) => setBulkData(e.target.value)}
              className="input-field h-48 font-mono text-sm resize-none"
              placeholder={EXCEL_HEADERS.join('\t')}
            />

            {bulkPreview.length ? (
              <div className="mt-4 border rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase">Preview (first 20)</div>
                <div className="p-4 text-sm text-gray-700 space-y-1">
                  {bulkPreview.map((r, idx) => (
                    <div key={idx} className="font-mono text-xs">
                      {r.customer_number || '(blank)'} | {r.company_name} | {r.city_name || ''} | {r.remarks || ''}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-3 mt-6">
              <button onClick={previewBulk} className="btn-secondary flex items-center gap-2">
                <Eye size={18} />
                Preview Data
              </button>
              <button onClick={importBulk} className="btn-primary flex-1">
                Import / Update (Rules)
              </button>
              <button
                onClick={() => {
                  setShowBulkModal(false);
                  setBulkPreview([]);
                }}
                className="btn-secondary px-8"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Customer Modal */}
      {showAddModal ? (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-3xl max-h-[86vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold">Add Customer Address</h3>
                <p className="text-xs text-gray-600 mt-1">
                  Only Customer Number and Company Name are required. Contact, GPS, address, and other fields are optional.
                </p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setShowAddModal(false)}>
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
              <label className="text-[11px] font-bold">
                Customer Number
                <input className="input-field mt-1" value={addForm.customer_number} onChange={(e) => setAddForm((s) => ({ ...s, customer_number: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Company Name
                <input className="input-field mt-1" value={addForm.company_name} onChange={(e) => setAddForm((s) => ({ ...s, company_name: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                City Name
                <input className="input-field mt-1" value={addForm.city_name} onChange={(e) => setAddForm((s) => ({ ...s, city_name: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                GPS
                <input className="input-field mt-1" value={addForm.gps} onChange={(e) => setAddForm((s) => ({ ...s, gps: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Address
                <textarea className="input-field mt-1 h-20" value={addForm.address} onChange={(e) => setAddForm((s) => ({ ...s, address: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                Contact Person
                <input className="input-field mt-1" value={addForm.contact_person} onChange={(e) => setAddForm((s) => ({ ...s, contact_person: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                ContactPersonNumber1
                <input
                  className="input-field mt-1"
                  value={addForm.contact_person_number_1}
                  onChange={(e) => setAddForm((s) => ({ ...s, contact_person_number_1: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Email 1
                <input className="input-field mt-1" value={addForm.email_1} onChange={(e) => setAddForm((s) => ({ ...s, email_1: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Designation / Job
                <input
                  className="input-field mt-1"
                  value={addForm.designation_job}
                  onChange={(e) => setAddForm((s) => ({ ...s, designation_job: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold">
                2nd Name
                <input className="input-field mt-1" value={addForm.second_name} onChange={(e) => setAddForm((s) => ({ ...s, second_name: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold">
                2nd Number
                <input className="input-field mt-1" value={addForm.second_number} onChange={(e) => setAddForm((s) => ({ ...s, second_number: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                2nd Email
                <input className="input-field mt-1" value={addForm.second_email} onChange={(e) => setAddForm((s) => ({ ...s, second_email: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Designation / Job title2
                <input
                  className="input-field mt-1"
                  value={addForm.designation_job_title_2}
                  onChange={(e) => setAddForm((s) => ({ ...s, designation_job_title_2: e.target.value }))}
                />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Remarks
                <textarea className="input-field mt-1 h-16" value={addForm.remarks} onChange={(e) => setAddForm((s) => ({ ...s, remarks: e.target.value }))} />
              </label>
              <label className="text-[11px] font-bold sm:col-span-2">
                Address Type
                <select className="input-field mt-1" value={addForm.address_type} onChange={(e) => setAddForm((s) => ({ ...s, address_type: e.target.value }))}>
                  <option value="permanent">Permanent</option>
                  <option value="temporary">Temporary</option>
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-2 justify-end mt-5">
              <button type="button" className="btn-secondary" onClick={() => setShowAddModal(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={createCustomerRow}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

