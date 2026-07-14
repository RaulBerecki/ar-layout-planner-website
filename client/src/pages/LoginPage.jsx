import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function LoginPage() {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [orgMode, setOrgMode] = useState('create'); // 'create' | 'join'
  const [orgName, setOrgName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const isRegister = mode === 'register';

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setConfirm('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (isRegister && password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (isRegister) {
        await register({ username, password, orgMode, orgName, inviteCode });
      } else {
        await login(username, password);
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">AR Manufacturing Layout Planner</h1>
        <p className="auth-subtitle">
          {isRegister ? 'Create your account' : 'Sign in to continue'}
        </p>

        <div className="auth-tabs">
          <button
            type="button"
            className={!isRegister ? 'tab active' : 'tab'}
            onClick={() => switchMode('login')}
          >
            Login
          </button>
          <button
            type="button"
            className={isRegister ? 'tab active' : 'tab'}
            onClick={() => switchMode('register')}
          >
            Register
          </button>
        </div>

        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              minLength={3}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              required
              minLength={6}
            />
          </label>
          {isRegister && (
            <>
              <label>
                Confirm password
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={6}
                />
              </label>

              <div className="org-section">
                <span className="org-section-title">Organization / department</span>
                <div className="org-choice">
                  <label className="radio">
                    <input
                      type="radio"
                      name="orgMode"
                      checked={orgMode === 'create'}
                      onChange={() => setOrgMode('create')}
                    />
                    Create new
                  </label>
                  <label className="radio">
                    <input
                      type="radio"
                      name="orgMode"
                      checked={orgMode === 'join'}
                      onChange={() => setOrgMode('join')}
                    />
                    Join existing
                  </label>
                </div>
                {orgMode === 'create' ? (
                  <label>
                    Organization name
                    <input
                      type="text"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      placeholder="e.g. Assembly Department"
                      required
                    />
                  </label>
                ) : (
                  <label>
                    Invite code
                    <input
                      type="text"
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                      placeholder="e.g. K7KP2MRX"
                      className="invite-input"
                      required
                    />
                  </label>
                )}
              </div>
            </>
          )}

          {error && <div className="form-error">{error}</div>}

          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
