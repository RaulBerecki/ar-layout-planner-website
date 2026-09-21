import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, getStoredUser, storeSession, clearSession } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => (getToken() ? getStoredUser() : null));
  // Registration signs the user in only after they acknowledge their recovery
  // code, so the session waits here until then.
  const [pendingSession, setPendingSession] = useState(null);

  const login = async (username, password) => {
    const data = await api.login(username, password);
    storeSession(data.token, data.user);
    setUser(data.user);
  };

  const register = async (details) => {
    const data = await api.register(details);
    setPendingSession({ token: data.token, user: data.user });
    return data.recovery_code;
  };

  const enterApp = () => {
    if (!pendingSession) return;
    storeSession(pendingSession.token, pendingSession.user);
    setUser(pendingSession.user);
    setPendingSession(null);
  };

  const logout = () => {
    clearSession();
    setUser(null);
  };

  // Reloads the signed-in user's role and permissions, which an administrator may have changed.
  const refreshUser = useCallback(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const { user: fresh } = await api.me();
      storeSession(token, fresh);
      setUser(fresh);
    } catch (err) {
      if (/token|authenticated/i.test(err.message)) {
        clearSession();
        setUser(null);
      }
    }
  }, []);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  // Organization-wide permissions (see server/permissions.js). The server enforces them too;
  // this only decides which buttons to show.
  const can = (permission) => Boolean(user?.permissions?.includes(permission));

  return (
    <AuthContext.Provider value={{ user, login, register, enterApp, logout, refreshUser, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
