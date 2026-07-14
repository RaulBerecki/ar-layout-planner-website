import { createContext, useContext, useState } from 'react';
import { api, getToken, getStoredUser, storeSession, clearSession } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => (getToken() ? getStoredUser() : null));

  const login = async (username, password) => {
    const data = await api.login(username, password);
    storeSession(data.token, data.user);
    setUser(data.user);
  };

  const register = async (details) => {
    const data = await api.register(details);
    storeSession(data.token, data.user);
    setUser(data.user);
  };

  const logout = () => {
    clearSession();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
