import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../api';

export default function LoginPage() {
  const [mode, setMode] = useState('login'); // 'login' | 'register' | 'recover'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [orgMode, setOrgMode] = useState('create'); // 'create' | 'join'
  const [orgName, setOrgName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  // Set once a code has been issued; shows the "save this code" screen
  const [issued, setIssued] = useState(null); // { code, context }
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { login, register, enterApp } = useAuth();
  const navigate = useNavigate();

  const isRegister = mode === 'register';
  const isRecover = mode === 'recover';

  const switchMode = (next) => {
    setMode(next);
    setError('');
    setPassword('');
    setConfirm('');
    setRecoveryInput('');
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(issued.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable; the code is on screen to copy manually
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if ((isRegister || isRecover) && password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (isRegister) {
        const code = await register({ username, password, orgMode, orgName, inviteCode });
        setIssued({ code, context: 'register' });
      } else if (isRecover) {
        const data = await api.recover({
          username,
          recoveryCode: recoveryInput,
          newPassword: password,
        });
        setIssued({ code: data.recovery_code, context: 'recover' });
      } else {
        await login(username, password);
        navigate('/', { replace: true });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // ---------- Recovery code screen ----------
  if (issued) {
    const fromRegister = issued.context === 'register';
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1 className="auth-title">
            {fromRegister ? 'Account created' : 'Password changed'}
          </h1>
          <p className="auth-subtitle">Save your recovery code</p>

          <div className="code-panel">
            <code className="recovery-code">{issued.code}</code>
            <button type="button" className="btn small" onClick={copyCode}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <p className="code-note">
            This is the only way to reset your password if you forget it. It is
            shown <strong>once</strong> and cannot be retrieved later, so store
            it somewhere safe. Using it issues a new code.
          </p>

          <button
            className="btn primary full-width"
            onClick={() => {
              if (fromRegister) {
                enterApp();
                navigate('/', { replace: true });
              } else {
                setIssued(null);
                switchMode('login');
              }
            }}
          >
            {fromRegister ? 'I saved it — continue' : 'I saved it — sign in'}
          </button>
        </div>
      </div>
    );
  }

  // ---------- Forgot password ----------
  if (isRecover) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1 className="auth-title">Reset your password</h1>
          <p className="auth-subtitle">Use the recovery code you saved</p>

          <form onSubmit={handleSubmit} className="auth-form">
            <label>
              Username
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Recovery code
              <input
                type="text"
                value={recoveryInput}
                onChange={(e) => setRecoveryInput(e.target.value.toUpperCase())}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className="invite-input"
                required
              />
            </label>
            <label>
              New password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={6}
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                minLength={6}
              />
            </label>

            {error && <div className="form-error">{error}</div>}

            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Please wait…' : 'Set new password'}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => switchMode('login')}
            >
              Back to sign in
            </button>
          </form>

          <p className="code-note">
            Lost the recovery code as well? Ask whoever runs this site to reset
            the account for you.
          </p>
        </div>
      </div>
    );
  }

  // ---------- Login / register ----------
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

          {!isRegister && (
            <button
              type="button"
              className="link-button"
              onClick={() => switchMode('recover')}
            >
              Forgot password?
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
