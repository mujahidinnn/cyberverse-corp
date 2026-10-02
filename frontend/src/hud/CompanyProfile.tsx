import { useEffect, useState } from 'react';
import { apiText } from '../net/api';
import { Icon, Loading } from './icons';
import { Markdown } from './Markdown';

export function CompanyProfile({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiText('/company').then(setText).catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal report" role="dialog" aria-modal="true" aria-labelledby="company-title" onClick={(e) => e.stopPropagation()}>
        <header className="report-head">
          <h2 id="company-title"><Icon name="executive" size={20} /> Profil Perusahaan</h2>
          <button className="ghost close" onClick={onClose} aria-label="Tutup profil"><Icon name="close" size={14} /></button>
        </header>
        {error && <p className="tone-bad">Gagal memuat profil: {error}</p>}
        {text === null && !error && <Loading>Memuat profil</Loading>}
        {text !== null && <div className="doc-scroll"><Markdown text={text || 'Profil perusahaan belum diisi.'} /></div>}
      </div>
    </div>
  );
}
