/**
 * Display dates stored as YYYY-MM-DD (or ISO strings) as DD-MM-YYYY in the UI.
 * Editing/forms still use native date inputs with YYYY-MM-DD values where applicable.
 */

export function formatDateDDMMYYYY(value) {
  if (value === null || value === undefined || value === '') return '—';
  const s = String(value).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[3]}-${iso[2]}-${iso[1]}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }
  return s;
}
