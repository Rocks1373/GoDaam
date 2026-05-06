import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScanLine,
  Upload,
  Play,
  Eye,
  Save,
  FileSpreadsheet,
  Truck,
  Package,
  Settings2,
  Trash2,
  Plus,
  RefreshCw,
  LayoutList,
  Sparkles,
} from 'lucide-react';
import { ocrCenterApi } from '../services/api';

const DOC_TYPES = [
  { id: 'vendor_invoice', label: 'Vendor Invoice' },
  { id: 'packing_list', label: 'Packing List' },
  { id: 'customer_po', label: 'Customer PO' },
  { id: 'multiple_po', label: 'Multiple PO' },
  { id: 'multiple_invoice', label: 'Multiple Invoice' },
];

const SPLIT_OPTIONS = [
  { id: 'by_invoice_number', label: 'Split by Invoice Number' },
  { id: 'by_po_number', label: 'Split by PO Number' },
  { id: 'by_page', label: 'Split by Page' },
  { id: 'by_keyword', label: 'Split by keyword' },
];

/** All header keys available in Field mapping + review (commercial invoice first). */
const MAP_HEADER_KEYS = [
  ['commercial_invoice_number', 'Commercial Invoice Number'],
  ['commercial_invoice_date', 'Commercial Invoice Date'],
  ['invoice_number', 'Invoice Number'],
  ['invoice_date', 'Invoice Date'],
  ['po_number', 'PO Number'],
  ['vendor_name', 'Vendor Name'],
  ['customer_name', 'Customer Name'],
  ['currency', 'Currency'],
  ['packing_list_number', 'Packing List Number'],
  ['delivery_number', 'Delivery Number'],
  ['remarks', 'Remarks'],
];

const ITEM_COL_KEYS = [
  ['part_number', 'Part Number'],
  ['sap_part_number', 'SAP Part Number'],
  ['description', 'Description'],
  ['qty', 'Qty'],
  ['uom', 'UOM'],
  ['unit_price', 'Unit Price'],
  ['total_price', 'Total Price'],
];

const SUGGESTED_PATTERN_NAMES = [
  'Schneider Invoice',
  'Schneider Packing List',
  'CommScope Invoice',
  'CommScope Packing List',
  'STC Customer PO',
  'Regular PO',
  'Commercial Invoice (C801-style)',
];

function emptyFieldMappings() {
  const headers = {};
  for (const [k] of MAP_HEADER_KEYS) {
    headers[k] = { mode: 'anchor_rest_of_line', anchor: '', regex: '' };
  }
  return { headers };
}

function emptyTableMapping() {
  return {
    startMarker: '',
    endMarker: '',
    columns: [
      { fieldKey: 'part_number', colIndex: 0 },
      { fieldKey: 'description', colIndex: 1 },
      { fieldKey: 'qty', colIndex: 2 },
      { fieldKey: 'uom', colIndex: 3 },
      { fieldKey: 'unit_price', colIndex: 4 },
    ],
  };
}

/** Example layout: label line then value (e.g. PO_C801 — Commercial Invoice Number / Date, SAP-style line table). */
function commercialInvoiceC801Preset() {
  const headers = emptyFieldMappings().headers;
  headers.commercial_invoice_number = { mode: 'anchor_next_line', anchor: 'Commercial Invoice Number' };
  headers.commercial_invoice_date = { mode: 'anchor_next_line', anchor: 'Commercial Invoice Date' };
  headers.po_number = { mode: 'anchor_next_line', anchor: 'PO Number' };
  return {
    headers,
    tableMapping: {
      startMarker: 'Material',
      endMarker: '',
      columns: [
        { fieldKey: 'part_number', colIndex: 0 },
        { fieldKey: 'description', colIndex: 1 },
        { fieldKey: 'qty', colIndex: 2 },
        { fieldKey: 'uom', colIndex: 3 },
        { fieldKey: 'unit_price', colIndex: 4 },
      ],
    },
  };
}

export default function OcrCenter() {
  const [mainTab, setMainTab] = useState('upload');
  const [templates, setTemplates] = useState([]);
  const [resultsList, setResultsList] = useState([]);
  const [settingsJson, setSettingsJson] = useState('{\n  "defaultLanguage": "eng",\n  "notes": ""\n}');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [documentType, setDocumentType] = useState('vendor_invoice');
  const [useSavedPattern, setUseSavedPattern] = useState(true);
  const [templateId, setTemplateId] = useState('');
  const [file, setFile] = useState(null);
  const [currentResult, setCurrentResult] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [fieldMappings, setFieldMappings] = useState(() => emptyFieldMappings());
  const [tableMapping, setTableMapping] = useState(() => emptyTableMapping());
  const [headerExtracted, setHeaderExtracted] = useState({});
  const [itemsExtracted, setItemsExtracted] = useState([]);
  const [multiDoc, setMultiDoc] = useState('no');
  const [splitStrategy, setSplitStrategy] = useState('by_keyword');
  const [splitKeyword, setSplitKeyword] = useState('Invoice');
  const [mapTargetField, setMapTargetField] = useState('commercial_invoice_number');
  /** When true, clicking a text line sets anchor + "value on next line" (commercial invoice blocks). */
  const [mapAssumeNextLine, setMapAssumeNextLine] = useState(true);
  const [patternForm, setPatternForm] = useState({
    template_name: '',
    party_name: '',
    description: '',
    is_active: true,
  });

  const previewUrl = useMemo(() => {
    if (!currentResult?.file_path) return '';
    const p = String(currentResult.file_path).replace(/^\/+/, '');
    return `/${p}`;
  }, [currentResult]);

  const loadTemplates = useCallback(async () => {
    try {
      const rows = await ocrCenterApi.listTemplates();
      setTemplates(rows || []);
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    }
  }, []);

  const loadResults = useCallback(async () => {
    try {
      const rows = await ocrCenterApi.listResults(200);
      setResultsList(rows || []);
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await ocrCenterApi.getSettings();
      setSettingsJson(JSON.stringify(s || {}, null, 2));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    if (mainTab === 'results') loadResults();
    if (mainTab === 'settings') loadSettings();
  }, [mainTab, loadResults, loadSettings]);

  const applyTemplateToEditors = (tpl) => {
    try {
      const fm = typeof tpl.field_mappings_json === 'string' ? JSON.parse(tpl.field_mappings_json) : tpl.field_mappings_json;
      const tm = typeof tpl.table_mappings_json === 'string' ? JSON.parse(tpl.table_mappings_json) : tpl.table_mappings_json;
      if (fm?.headers) setFieldMappings(fm);
      else if (fm && typeof fm === 'object') setFieldMappings({ headers: { ...emptyFieldMappings().headers, ...fm } });
      else setFieldMappings(emptyFieldMappings());
      if (tm && typeof tm === 'object') setTableMapping({ ...emptyTableMapping(), ...tm });
    } catch {
      setFieldMappings(emptyFieldMappings());
      setTableMapping(emptyTableMapping());
    }
  };

  const applyCommercialPreset = () => {
    const p = commercialInvoiceC801Preset();
    setFieldMappings({ headers: p.headers });
    setTableMapping(p.tableMapping);
    setUseSavedPattern(false);
    setTemplateId('');
    setMapAssumeNextLine(true);
    setMsg('Applied Commercial Invoice (C801-style) anchors: label / value on next line; table from "Material" row.');
  };

  const onUpload = async () => {
    setMsg('');
    if (!file) {
      setMsg('Choose a PDF or image first.');
      return;
    }
    setBusy(true);
    try {
      const row = await ocrCenterApi.upload(file, {
        document_type: documentType,
        template_id: useSavedPattern && templateId ? Number(templateId) : '',
      });
      setCurrentResult(row);
      setMsg(`Uploaded as result #${row.id}. Open Field mapping to set anchors, then Run OCR.`);
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const buildSplitRulesPayload = () => {
    if (multiDoc !== 'yes') return undefined;
    const rules = { multipleDocuments: true, strategy: splitStrategy };
    if (splitStrategy === 'by_keyword' || splitStrategy === 'by_invoice_number' || splitStrategy === 'by_po_number') {
      rules.keyword = splitKeyword;
    }
    return rules;
  };

  const onRunOcr = async () => {
    setMsg('');
    if (!currentResult?.id) {
      setMsg('Upload a document first (Upload tab).');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        resultId: currentResult.id,
        document_type: documentType,
        multipleDocuments: multiDoc === 'yes' ? 'yes' : 'no',
        splitStrategy: multiDoc === 'yes' ? splitStrategy : undefined,
        splitKeyword: multiDoc === 'yes' ? splitKeyword : undefined,
        split_rules_json: buildSplitRulesPayload(),
      };
      if (useSavedPattern && templateId) {
        payload.templateId = Number(templateId);
      } else {
        payload.field_mappings_json = { headers: fieldMappings.headers || fieldMappings };
        payload.table_mappings_json = tableMapping;
      }
      const data = await ocrCenterApi.run(payload);
      setBlocks(data.blocks || []);
      setWarnings(data.warnings || []);
      const r = data.result;
      setCurrentResult(r);
      try {
        setHeaderExtracted(JSON.parse(r.extracted_header_json || '{}'));
      } catch {
        setHeaderExtracted({});
      }
      try {
        setItemsExtracted(JSON.parse(r.extracted_items_json || '[]'));
      } catch {
        setItemsExtracted([]);
      }
      if ((data.resultIds || []).length > 1) {
        setMsg(`OCR finished — ${data.resultIds.length} segments (#${data.resultIds.join(', #')}). Review on Field mapping.`);
      } else {
        setMsg('OCR finished. Review and edit on Field mapping tab.');
      }
      setMainTab('mapping');
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const onSaveResult = async () => {
    if (!currentResult?.id) return;
    setBusy(true);
    try {
      const row = await ocrCenterApi.saveResult({
        id: currentResult.id,
        extracted_header_json: headerExtracted,
        extracted_items_json: itemsExtracted,
        status: 'Saved',
        template_id: templateId ? Number(templateId) : null,
      });
      setCurrentResult(row);
      setMsg('Result saved.');
      loadResults();
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const onSavePattern = async () => {
    const name = String(patternForm.template_name || '').trim();
    if (!name) {
      setMsg('Enter a pattern name before saving.');
      return;
    }
    setBusy(true);
    try {
      await ocrCenterApi.createTemplate({
        template_name: name,
        party_name: patternForm.party_name || null,
        document_type: documentType,
        description: patternForm.description || null,
        is_active: patternForm.is_active,
        field_mappings_json: { headers: fieldMappings.headers || fieldMappings },
        table_mappings_json: tableMapping,
        split_rules_json: buildSplitRulesPayload() || null,
        sample_file_path: currentResult?.file_path || null,
      });
      setMsg(`Pattern "${name}" saved.`);
      loadTemplates();
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const onExportExcel = async () => {
    if (!currentResult?.id) return;
    try {
      await ocrCenterApi.exportExcel(currentResult.id);
    } catch (e) {
      setMsg(e?.response?.data?.error || e.message);
    }
  };

  const onBlockLineClick = (lineRaw) => {
    const line = String(lineRaw || '').trim();
    if (!line) return;
    const mode = mapAssumeNextLine ? 'anchor_next_line' : 'anchor_rest_of_line';
    const anchorGuess = line.includes(':') ? line.split(':')[0].trim() : line.slice(0, 48).trim();
    setFieldMappings((prev) => ({
      ...prev,
      headers: {
        ...(prev.headers || {}),
        [mapTargetField]: {
          mode,
          anchor: anchorGuess,
          regex: (prev.headers && prev.headers[mapTargetField]?.regex) || '',
        },
      },
    }));
  };

  const tabBtn = (id, label, icon) => (
    <button
      key={id}
      type="button"
      onClick={() => setMainTab(id)}
      className={`px-3 py-2 rounded-lg text-xs font-bold border transition ${
        mainTab === id
          ? 'bg-primary-600 text-white border-primary-600'
          : 'bg-white text-gray-700 border-gray-200 hover:border-primary-300'
      }`}
    >
      <span className="inline-flex items-center gap-1.5">
        {icon}
        {label}
      </span>
    </button>
  );

  const mappingAnchorsPanel = (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3 shadow-sm max-h-[560px] overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-800">Header field mapping</h2>
        <button
          type="button"
          onClick={applyCommercialPreset}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-[11px] font-bold"
        >
          <Sparkles className="w-3.5 h-3.5" />
          Commercial invoice preset (C801-style)
        </button>
      </div>
      <p className="text-[11px] text-gray-500">
        Example first invoice: Commercial Invoice Number <strong>9010119196</strong>, Date <strong>02 FEB 2026</strong>, PO{' '}
        <strong>5500001285</strong>, line <strong>760242982</strong> / <strong>360DPiP-24LCA-SM</strong> / qty <strong>4.000</strong>, UOM{' '}
        <strong>EA</strong>, unit <strong>1.47000</strong>. Use <em>Anchor (next line)</em> when the label is alone on one line and the
        value is below.
      </p>
      {useSavedPattern && templateId && (
        <div className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
          A saved template is selected on the Upload tab — Run OCR uses the template only. Turn off &quot;Use saved pattern&quot; there to
          apply the anchors you edit here.
        </div>
      )}
      <div className="space-y-2">
        {MAP_HEADER_KEYS.map(([key, label]) => {
          const h = (fieldMappings.headers && fieldMappings.headers[key]) || { mode: 'anchor_rest_of_line', anchor: '' };
          return (
            <div key={key} className="grid grid-cols-12 gap-1 items-center text-[11px]">
              <div className="col-span-3 font-bold text-gray-600 truncate" title={label}>
                {label}
              </div>
              <select
                className="col-span-3 border rounded px-1 py-1"
                value={h.mode || 'anchor_rest_of_line'}
                onChange={(e) =>
                  setFieldMappings((prev) => ({
                    ...prev,
                    headers: { ...(prev.headers || {}), [key]: { ...h, mode: e.target.value } },
                  }))
                }
              >
                <option value="anchor_rest_of_line">Anchor (same line)</option>
                <option value="anchor_next_line">Anchor (next line)</option>
                <option value="regex">Regex</option>
              </select>
              <input
                className="col-span-6 border rounded px-1 py-1"
                placeholder={h.mode === 'regex' ? 'Pattern (capture group 1)' : 'Anchor text'}
                value={h.mode === 'regex' ? h.regex || '' : h.anchor || ''}
                onChange={(e) =>
                  setFieldMappings((prev) => ({
                    ...prev,
                    headers: {
                      ...(prev.headers || {}),
                      [key]: h.mode === 'regex' ? { ...h, regex: e.target.value } : { ...h, anchor: e.target.value },
                    },
                  }))
                }
              />
            </div>
          );
        })}
      </div>

      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="text-xs font-bold text-gray-700">Line items table</div>
        <p className="text-[10px] text-gray-500">Table start = first data row after a line containing this text (e.g. Material / column headers).</p>
        <input
          className="w-full border rounded-lg px-2 py-1 text-xs"
          placeholder='Table start — line contains (e.g. "Material")'
          value={tableMapping.startMarker || ''}
          onChange={(e) => setTableMapping((t) => ({ ...t, startMarker: e.target.value }))}
        />
        <input
          className="w-full border rounded-lg px-2 py-1 text-xs"
          placeholder="Table end — line contains (optional)"
          value={tableMapping.endMarker || ''}
          onChange={(e) => setTableMapping((t) => ({ ...t, endMarker: e.target.value }))}
        />
        {(tableMapping.columns || []).map((c, idx) => (
          <div key={idx} className="flex gap-2 items-center text-xs">
            <select
              className="border rounded px-1 py-1 flex-1"
              value={c.fieldKey}
              onChange={(e) => {
                const cols = [...(tableMapping.columns || [])];
                cols[idx] = { ...c, fieldKey: e.target.value };
                setTableMapping((t) => ({ ...t, columns: cols }));
              }}
            >
              {ITEM_COL_KEYS.map(([k, lab]) => (
                <option key={k} value={k}>
                  {lab}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              className="w-16 border rounded px-1 py-1"
              value={c.colIndex}
              onChange={(e) => {
                const cols = [...(tableMapping.columns || [])];
                cols[idx] = { ...c, colIndex: Number(e.target.value) };
                setTableMapping((t) => ({ ...t, columns: cols }));
              }}
            />
            <button
              type="button"
              className="text-red-600"
              onClick={() => {
                const cols = (tableMapping.columns || []).filter((_, i) => i !== idx);
                setTableMapping((t) => ({ ...t, columns: cols }));
              }}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-xs font-bold text-primary-600 flex items-center gap-1"
          onClick={() =>
            setTableMapping((t) => ({
              ...t,
              columns: [...(t.columns || []), { fieldKey: 'part_number', colIndex: 0 }],
            }))
          }
        >
          <Plus className="w-3.5 h-3.5" /> Add column
        </button>
      </div>

      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="text-xs font-bold text-gray-700">Recognized lines → click to set anchor for target field</div>
        <label className="flex items-center gap-2 text-[11px] font-bold text-gray-600">
          <input type="checkbox" checked={mapAssumeNextLine} onChange={(e) => setMapAssumeNextLine(e.target.checked)} />
          Treat clicked line as label; value on next line (commercial layout)
        </label>
        <select
          className="w-full border rounded-lg px-2 py-1 text-xs mb-1"
          value={mapTargetField}
          onChange={(e) => setMapTargetField(e.target.value)}
        >
          {MAP_HEADER_KEYS.map(([k, lab]) => (
            <option key={k} value={k}>
              Map to: {lab}
            </option>
          ))}
        </select>
        <div className="max-h-48 overflow-y-auto text-[10px] font-mono bg-gray-50 rounded border p-2 space-y-0.5">
          {blocks.length === 0 && <span className="text-gray-400">Run OCR to load lines from the PDF…</span>}
          {blocks.slice(0, 300).map((b, i) => (
            <button key={i} type="button" className="block w-full text-left hover:bg-primary-50 truncate" onClick={() => onBlockLineClick(b.text)}>
              {b.text}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="text-xs font-bold">Save OCR pattern</div>
        <input
          className="w-full border rounded-lg px-2 py-1 text-xs"
          placeholder="Pattern name"
          list="ocr-suggested-names"
          value={patternForm.template_name}
          onChange={(e) => setPatternForm((p) => ({ ...p, template_name: e.target.value }))}
        />
        <datalist id="ocr-suggested-names">
          {SUGGESTED_PATTERN_NAMES.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <input
          className="w-full border rounded-lg px-2 py-1 text-xs"
          placeholder="Vendor / Customer name"
          value={patternForm.party_name}
          onChange={(e) => setPatternForm((p) => ({ ...p, party_name: e.target.value }))}
        />
        <input
          className="w-full border rounded-lg px-2 py-1 text-xs"
          placeholder="Description"
          value={patternForm.description}
          onChange={(e) => setPatternForm((p) => ({ ...p, description: e.target.value }))}
        />
        <label className="flex items-center gap-2 text-xs font-bold">
          <input type="checkbox" checked={patternForm.is_active} onChange={(e) => setPatternForm((p) => ({ ...p, is_active: e.target.checked }))} />
          Active
        </label>
        <button type="button" disabled={busy} onClick={onSavePattern} className="w-full py-2 rounded-lg bg-primary-700 text-white text-xs font-bold">
          Save pattern
        </button>
      </div>
    </div>
  );

  const reviewPanel = currentResult ? (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 min-h-[400px]">
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden flex flex-col">
          <div className="text-xs font-bold text-gray-600 px-3 py-2 border-b bg-gray-50">Document preview</div>
          <div className="flex-1 min-h-[320px] bg-gray-100">
            {/\.pdf$/i.test(currentResult.original_file_name || '') ? (
              <iframe title="preview" src={previewUrl} className="w-full h-full min-h-[320px] border-0" />
            ) : (
              <img src={previewUrl} alt="uploaded" className="max-w-full max-h-[440px] object-contain mx-auto" />
            )}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm flex flex-col">
          <div className="text-xs font-bold text-gray-600 px-3 py-2 border-b bg-gray-50">Extracted header (editable)</div>
          <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2 overflow-y-auto max-h-[240px]">
            {MAP_HEADER_KEYS.map(([key, label]) => (
              <label key={key} className="text-[11px]">
                <span className="font-bold text-gray-500 block mb-0.5">{label}</span>
                <input
                  className="w-full border rounded px-2 py-1 text-xs"
                  value={headerExtracted[key] ?? ''}
                  onChange={(e) => setHeaderExtracted((h) => ({ ...h, [key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="text-xs font-bold text-gray-600 px-3 py-2 border-t border-b bg-gray-50">Line items (editable)</div>
          <div className="overflow-x-auto flex-1 min-h-[180px]">
            <table className="min-w-full text-[11px]">
              <thead>
                <tr className="bg-gray-50 border-b">
                  {ITEM_COL_KEYS.map(([k, lab]) => (
                    <th key={k} className="text-left px-2 py-1 font-bold text-gray-600">
                      {lab}
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {itemsExtracted.map((row, ri) => (
                  <tr key={ri} className="border-b border-gray-100">
                    {ITEM_COL_KEYS.map(([k]) => (
                      <td key={k} className="px-1 py-0.5">
                        <input
                          className="w-full border rounded px-1 py-0.5"
                          value={row[k] ?? ''}
                          onChange={(e) => {
                            const next = [...itemsExtracted];
                            next[ri] = { ...next[ri], [k]: e.target.value };
                            setItemsExtracted(next);
                          }}
                        />
                      </td>
                    ))}
                    <td>
                      <button type="button" className="text-red-600 p-1" onClick={() => setItemsExtracted(itemsExtracted.filter((_, i) => i !== ri))}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="m-2 text-xs font-bold text-primary-600 flex items-center gap-1"
              onClick={() => setItemsExtracted([...itemsExtracted, { part_number: '', qty: '', uom: '' }])}
            >
              <Plus className="w-3.5 h-3.5" /> Add row
            </button>
          </div>
          <div className="p-3 border-t flex flex-wrap gap-2 bg-gray-50">
            <button type="button" onClick={onExportExcel} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-700 text-white text-xs font-bold">
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Export Excel
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const r = await ocrCenterApi.sendInbound(currentResult.id);
                  setMsg(r.message || JSON.stringify(r));
                } catch (e) {
                  setMsg(e?.response?.data?.error || e.message);
                }
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-bold"
            >
              <Truck className="w-3.5 h-3.5" />
              Send to Inbound
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const r = await ocrCenterApi.sendOutbound(currentResult.id);
                  setMsg(r.message || JSON.stringify(r));
                } catch (e) {
                  setMsg(e?.response?.data?.error || e.message);
                }
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-bold"
            >
              <Package className="w-3.5 h-3.5" />
              Send to Outbound
            </button>
            <button type="button" onClick={onSaveResult} disabled={busy} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary-600 text-white text-xs font-bold">
              <Save className="w-3.5 h-3.5" />
              Save result
            </button>
          </div>
        </div>
      </div>
  ) : null;

  return (
    <div className="p-4 max-w-[1600px] mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-black text-gray-900 flex items-center gap-2">
            <ScanLine className="w-6 h-6 text-primary-600" />
            OCR Center
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Upload on the first tab; use <strong>Field mapping</strong> for commercial invoice labels (e.g. PO_C801), table columns, and
            saving patterns.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tabBtn('upload', 'Upload Document', <Upload className="w-3.5 h-3.5" />)}
          {tabBtn('mapping', 'Field mapping', <LayoutList className="w-3.5 h-3.5" />)}
          {tabBtn('templates', 'OCR Templates / Patterns', <FileSpreadsheet className="w-3.5 h-3.5" />)}
          {tabBtn('results', 'OCR Results', <Eye className="w-3.5 h-3.5" />)}
          {tabBtn('settings', 'OCR Settings', <Settings2 className="w-3.5 h-3.5" />)}
        </div>
      </div>

      {msg && (
        <div className="text-xs font-medium text-primary-800 bg-primary-50 border border-primary-200 rounded-lg px-3 py-2">
          {msg}
        </div>
      )}

      {mainTab === 'upload' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-primary-100 bg-primary-50/80 p-3 text-[11px] text-gray-700">
            <strong>Flow:</strong> choose document type and file → Upload → open <strong>Field mapping</strong> to apply the commercial
            invoice preset or custom anchors → Run OCR there (or here) → edit values → Save result / Export.
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3 shadow-sm max-w-3xl">
            <h2 className="text-sm font-bold text-gray-800">Document & file</h2>
            <label className="block text-[11px] font-bold text-gray-500">Document type</label>
            <select className="w-full border rounded-lg px-2 py-2 text-xs" value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
              {DOC_TYPES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>

            <div className="flex gap-4 text-xs font-bold">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" checked={useSavedPattern} onChange={() => setUseSavedPattern(true)} />
                Use saved pattern
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" checked={!useSavedPattern} onChange={() => setUseSavedPattern(false)} />
                No — map on Field mapping tab
              </label>
            </div>

            {useSavedPattern && (
              <div>
                <label className="block text-[11px] font-bold text-gray-500 mb-1">Saved pattern</label>
                <select
                  className="w-full border rounded-lg px-2 py-2 text-xs"
                  value={templateId}
                  onChange={(e) => {
                    setTemplateId(e.target.value);
                    const t = templates.find((x) => String(x.id) === e.target.value);
                    if (t) applyTemplateToEditors(t);
                  }}
                >
                  <option value="">— Select —</option>
                  {templates
                    .filter((t) => t.is_active !== 0)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.template_name} ({t.document_type})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div className="border-t border-gray-100 pt-3 space-y-2">
              <div className="text-[11px] font-bold text-gray-500">Multiple documents in one PDF?</div>
              <div className="flex gap-3 text-xs font-bold">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={multiDoc === 'no'} onChange={() => setMultiDoc('no')} />
                  No
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={multiDoc === 'yes'} onChange={() => setMultiDoc('yes')} />
                  Yes — split by pattern
                </label>
              </div>
              {multiDoc === 'yes' && (
                <div className="grid grid-cols-1 gap-2 pl-1">
                  <select className="border rounded-lg px-2 py-1.5 text-xs" value={splitStrategy} onChange={(e) => setSplitStrategy(e.target.value)}>
                    {SPLIT_OPTIONS.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  {(splitStrategy === 'by_keyword' || splitStrategy === 'by_invoice_number' || splitStrategy === 'by_po_number') && (
                    <input
                      className="border rounded-lg px-2 py-1.5 text-xs"
                      placeholder="Keyword"
                      value={splitKeyword}
                      onChange={(e) => setSplitKeyword(e.target.value)}
                    />
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="block text-[11px] font-bold text-gray-500 mb-1">File (PDF, JPG, PNG)</label>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif" className="text-xs w-full" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={onUpload} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs font-bold disabled:opacity-50">
                <Upload className="w-3.5 h-3.5" />
                Upload
              </button>
              <button type="button" disabled={busy} onClick={onRunOcr} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary-600 text-white text-xs font-bold disabled:opacity-50">
                <Play className="w-3.5 h-3.5" />
                Run OCR
              </button>
              <button type="button" onClick={() => setMainTab('mapping')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-primary-400 text-primary-800 text-xs font-bold">
                <LayoutList className="w-3.5 h-3.5" />
                Open Field mapping
              </button>
            </div>
            {currentResult && (
              <p className="text-[11px] text-gray-500">
                Current file: <strong>{currentResult.original_file_name}</strong> — result #{currentResult.id}
              </p>
            )}
          </div>
        </div>
      )}

      {mainTab === 'mapping' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy || !currentResult} onClick={onRunOcr} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary-600 text-white text-xs font-bold disabled:opacity-50">
              <Play className="w-3.5 h-3.5" />
              Run OCR / refresh extraction
            </button>
            <button type="button" disabled={busy || !currentResult} onClick={onRunOcr} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-xs font-bold disabled:opacity-50">
              <Eye className="w-3.5 h-3.5" />
              Preview
            </button>
            <button type="button" onClick={() => setMainTab('upload')} className="text-xs font-bold text-gray-600 underline">
              Upload tab
            </button>
          </div>
          {!currentResult && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-xs font-bold px-3 py-2">
              Upload a PDF first (Upload tab), then return here to map fields and run OCR.
            </div>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
            {mappingAnchorsPanel}
            <div className="space-y-4 min-w-0">
              {reviewPanel || (
                <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-xs text-gray-500">
                  No document loaded yet. Use the Upload tab, then run OCR here.
                </div>
              )}
            </div>
          </div>
          {warnings.length > 0 && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{warnings.join(' ')}</div>
          )}
        </div>
      )}

      {mainTab === 'templates' && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b bg-gray-50">
            <h2 className="text-sm font-bold">Saved templates</h2>
            <button type="button" onClick={loadTemplates} className="inline-flex items-center gap-1 text-xs font-bold text-primary-700">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-gray-100 text-left">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Party</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Active</th>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id} className="border-t border-gray-100">
                    <td className="px-3 py-2 font-bold">{t.template_name}</td>
                    <td className="px-3 py-2">{t.party_name || '—'}</td>
                    <td className="px-3 py-2">{t.document_type}</td>
                    <td className="px-3 py-2">{t.is_active ? 'Yes' : 'No'}</td>
                    <td className="px-3 py-2 text-gray-500">{t.updated_at || t.created_at}</td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="text-primary-700 font-bold mr-2"
                        onClick={() => {
                          applyTemplateToEditors(t);
                          setTemplateId(String(t.id));
                          setUseSavedPattern(true);
                          setDocumentType(t.document_type);
                          setMainTab('upload');
                          setMsg(`Loaded template "${t.template_name}".`);
                        }}
                      >
                        Use
                      </button>
                      <button
                        type="button"
                        className="text-primary-700 font-bold mr-2"
                        onClick={() => {
                          applyTemplateToEditors(t);
                          setUseSavedPattern(false);
                          setTemplateId('');
                          setMainTab('mapping');
                          setMsg(`Loaded anchors from "${t.template_name}" — Run OCR when a file is uploaded.`);
                        }}
                      >
                        Edit mapping
                      </button>
                      <button
                        type="button"
                        className="text-red-600 font-bold"
                        onClick={async () => {
                          if (!window.confirm('Delete this template?')) return;
                          await ocrCenterApi.deleteTemplate(t.id);
                          loadTemplates();
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!templates.length && <div className="p-6 text-center text-gray-500 text-xs">No templates yet.</div>}
          </div>
        </div>
      )}

      {mainTab === 'results' && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 flex justify-between items-center">
            <h2 className="text-sm font-bold">Recent OCR results</h2>
            <button type="button" onClick={loadResults} className="text-xs font-bold text-primary-700">
              Refresh
            </button>
          </div>
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {resultsList.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono">{r.id}</td>
                  <td className="px-3 py-2 max-w-[200px] truncate">{r.original_file_name}</td>
                  <td className="px-3 py-2">{r.document_type}</td>
                  <td className="px-3 py-2">{r.status}</td>
                  <td className="px-3 py-2 text-gray-500">{r.created_at}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-primary-700 font-bold"
                      onClick={async () => {
                        const full = await ocrCenterApi.getResult(r.id);
                        setCurrentResult(full);
                        try {
                          setHeaderExtracted(JSON.parse(full.extracted_header_json || '{}'));
                        } catch {
                          setHeaderExtracted({});
                        }
                        try {
                          setItemsExtracted(JSON.parse(full.extracted_items_json || '[]'));
                        } catch {
                          setItemsExtracted([]);
                        }
                        setBlocks(full.raw_ocr?.blocks || []);
                        setWarnings(full.raw_ocr?.warnings || []);
                        setMainTab('mapping');
                        setMsg(`Opened result #${r.id} in Field mapping.`);
                      }}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {mainTab === 'settings' && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm space-y-3 max-w-2xl">
          <h2 className="text-sm font-bold">OCR settings (JSON)</h2>
          <p className="text-[11px] text-gray-500">Stored server-side for defaults (language, UI hints). Does not affect stock.</p>
          <textarea className="w-full h-48 border rounded-lg p-2 text-xs font-mono" value={settingsJson} onChange={(e) => setSettingsJson(e.target.value)} />
          <button
            type="button"
            className="px-4 py-2 rounded-lg bg-primary-600 text-white text-xs font-bold"
            onClick={async () => {
              try {
                const parsed = JSON.parse(settingsJson);
                await ocrCenterApi.updateSettings(parsed);
                setMsg('Settings saved.');
              } catch (e) {
                setMsg(e.message || 'Invalid JSON');
              }
            }}
          >
            Save settings
          </button>
        </div>
      )}
    </div>
  );
}
