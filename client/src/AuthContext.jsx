import { createContext, useContext, useState } from 'react';
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

  return (
    <AuthContext.Provider value={{ user, login, register, enterApp, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
