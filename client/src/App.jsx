import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import LoginPage from './pages/LoginPage';
import MainMenu from './pages/MainMenu';
import LinesPage from './pages/LinesPage';
import LinePrintPage from './pages/LinePrintPage';
import LineLandingPage from './pages/LineLandingPage';
import MembersPage from './pages/MembersPage';
import './App.css';

// Sends signed-out visitors to the login page, remembering where they wanted to go
// (e.g. a line opened by scanning its QR code) so they land there after signing in.
function RequireAuth({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

function RedirectIfAuthed({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user) return <Navigate to={location.state?.from || '/'} replace />;
  return children;
}

const protectedRoutes = [
  ['/', <MainMenu />],
  ['/lines', <LinesPage />],
  ['/lines/:id/print', <LinePrintPage />],
  ['/line/:code', <LineLandingPage />],
  ['/members', <MembersPage />],
];

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={
              <RedirectIfAuthed>
                <LoginPage />
              </RedirectIfAuthed>
            }
          />
          {protectedRoutes.map(([path, element]) => (
            <Route key={path} path={path} element={<RequireAuth>{element}</RequireAuth>} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
