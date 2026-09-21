import { NavLink } from 'react-router-dom';
import { useAuth } from '../AuthContext';

// Top bar shared by every signed-in page: title, navigation, current user and role.
export default function AppHeader({ subtitle }) {
  const { user, logout, can } = useAuth();
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div>
          <h1>AR Manufacturing Layout Planner</h1>
          {subtitle && <span className="muted">{subtitle}</span>}
        </div>
        <nav className="main-nav">
          <NavLink to="/" end className="nav-link">
            3D models
          </NavLink>
          <NavLink to="/lines" className="nav-link">
            Production lines
          </NavLink>
          {can('members.manage') && (
            <NavLink to="/members" className="nav-link">
              Members &amp; roles
            </NavLink>
          )}
        </nav>
      </div>
      <div className="topbar-right">
        <span className="muted">
          Signed in as <strong>{user?.username}</strong>
          {user?.role && <> · {user.role.name}</>}
        </span>
        <button className="btn ghost" onClick={logout}>
          Log out
        </button>
      </div>
    </header>
  );
}
