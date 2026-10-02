import type { ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <i key={i}>{part.slice(1, -1)}</i>;
    return part;
  });
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = out.length;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(<pre key={key}>{code.join('\n')}</pre>);
    } else if (/^\s*#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/#+/)![0].length, 4);
      const Tag = `h${level + 1}` as 'h2' | 'h3' | 'h4' | 'h5';
      out.push(<Tag key={key}>{inline(line.replace(/^\s*#+\s*/, ''))}</Tag>);
      i++;
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(<hr key={key} />);
      i++;
    } else if (line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
      out.push(
        <table key={key}>
          <thead><tr>{head.map((h, j) => <th key={j}>{inline(h)}</th>)}</tr></thead>
          <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>,
      );
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      out.push(<List key={key}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</List>);
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|([-*+]|\d+[.)])\s+)/.test(lines[i]) && !lines[i].includes('|'); i++) para.push(lines[i]);
      if (!para.length) para.push(lines[i++]);
      out.push(<p key={key}>{inline(para.join(' '))}</p>);
    }
  }
  return <div className="md">{out}</div>;
}
