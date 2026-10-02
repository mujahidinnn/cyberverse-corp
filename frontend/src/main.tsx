import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Office3DScene from './scene/Office3DScene';
import { Hud } from './hud/Hud';
import { connectOffice } from './net/wsClient';
import { setApiToken } from './net/api';
import '@fontsource/m-plus-rounded-1c/latin-400.css';
import '@fontsource/m-plus-rounded-1c/latin-700.css';
import '@fontsource/m-plus-rounded-1c/latin-800.css';
import './index.css';
import './theme';

const TOKEN_KEY = 'cyberverse_token';

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function App() {
  const [token, setToken] = useState<string | null>(readToken);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    setApiToken(token);
    return connectOffice(token, () => {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
      }
      setError('Token salah. Coba lagi.');
      setToken(null);
    });
  }, [token]);

  return (
    <>
      {}
      <Office3DScene />
      {token ? (
        <Hud />
      ) : (
        <div className="login-backdrop">
          <form
            className="login"
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-title"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                sessionStorage.setItem(TOKEN_KEY, input);
              } catch {
              }
              setError('');
              setToken(input);
            }}
          >
            <h1 id="login-title">CyberVerse Corp</h1>
            <p className="muted">Masuk sebagai Supervisor untuk mengelola kantor.</p>
            <label htmlFor="token">Token supervisor</label>
            <input id="token" type="password" value={input} onChange={(e) => setInput(e.target.value)} autoFocus
              aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} />
            {error && <p id="login-error" className="login-error" role="alert">{error}</p>}
            <button type="submit" disabled={!input}>Masuk</button>
          </form>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
