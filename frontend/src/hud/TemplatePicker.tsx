import { useState } from 'react';
import { Icon } from './icons';
import { COMMAND_TEMPLATES, fillTemplate, missingRequired, type CommandTemplate } from '../data/commandTemplates';

interface Props {
  onApply: (prompt: string, t: CommandTemplate) => void;
}

export function TemplatePicker({ onApply }: Props) {
  const [active, setActive] = useState<CommandTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const pick = (t: CommandTemplate) => {
    setActive(active?.id === t.id ? null : t);
    setValues({});
  };

  const missing = active ? missingRequired(active, values) : [];

  return (
    <div className="templates">
      {}
      {!active ? (
        <div className="template-grid" role="list" aria-label="Template perintah">
          {COMMAND_TEMPLATES.map((t) => (
            <button key={t.id} role="listitem" className="template-card" onClick={() => pick(t)}>
              <span className="template-icon"><Icon name={t.icon} size={20} /></span>
              <span className="template-title">{t.title}</span>
              <span className="template-meta">{t.category} · P{t.priority}</span>
              <span className="template-summary">{t.summary}</span>
            </button>
          ))}
        </div>
      ) : (
        <form
          className="template-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (missing.length) return;
            onApply(fillTemplate(active, values), active);
            setActive(null);
          }}
        >
          <div className="template-head">
            <span className="template-icon"><Icon name={active.icon} size={20} /></span>
            <span>
              <b>{active.title}</b>
              <small>{active.summary}</small>
            </span>
            <button type="button" className="ghost small" onClick={() => setActive(null)}>Ganti template</button>
          </div>
          <div className="template-fields">
            {active.fields.map((f, i) => {
              const id = `tpl-${active.id}-${f.key}`;
              const common = {
                id,
                value: values[f.key] ?? '',
                placeholder: f.placeholder,
                autoFocus: i === 0,
                onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                  setValues((v) => ({ ...v, [f.key]: e.target.value })),
              };
              return (
                <label key={f.key} htmlFor={id} className={f.multiline ? 'wide' : ''}>
                  <span>{f.label}{f.required && <b aria-label="wajib"> *</b>}</span>
                  {f.multiline ? <textarea rows={2} {...common} /> : <input {...common} />}
                </label>
              );
            })}
          </div>
          <details>
            <summary>Pratinjau perintah</summary>
            <pre className="template-preview">{fillTemplate(active, values)}</pre>
          </details>
          <div className="template-actions">
            <span className="muted">{missing.length > 0 ? `Lengkapi: ${missing.join(', ')}` : 'Teks masih bisa diedit di kotak perintah.'}</span>
            <button type="submit" disabled={missing.length > 0}>Masukkan ke kotak perintah</button>
          </div>
        </form>
      )}
    </div>
  );
}
