import { Construction } from 'lucide-react';

export default function UnderConstruction({ title = 'Under construction', detail }) {
  return (
    <div className="max-w-lg p-6">
      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-5 text-amber-950 shadow-sm">
        <Construction className="w-8 h-8 shrink-0 text-amber-700" aria-hidden />
        <div>
          <h2 className="text-lg font-bold text-gray-900 leading-tight">{title}</h2>
          <p className="mt-2 text-sm text-gray-700">
            {detail ||
              'This area is under construction. Please use the rest of the web app; we will enable this workflow when it is ready.'}
          </p>
        </div>
      </div>
    </div>
  );
}
