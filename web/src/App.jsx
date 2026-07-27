import React, { createContext, useContext, useState, useCallback } from "react";
import {
  BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate,
} from "react-router-dom";
import { isAuthed, clearSession, getUser } from "./api.js";
import Login from "./pages/Login.jsx";
import Home from "./pages/Home.jsx";
import Search from "./pages/Search.jsx";
import Movie from "./pages/Movie.jsx";
import Achievements from "./pages/Achievements.jsx";
import Friends from "./pages/Friends.jsx";
import Profile from "./pages/Profile.jsx";

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

function Toasts({ toasts }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <div className="t-label">{t.label}</div>
          <div className="t-name">{t.name}</div>
          {t.desc && <div className="muted">{t.desc}</div>}
          {t.points != null && <div className="t-pts">+{t.points} pts</div>}
        </div>
      ))}
    </div>
  );
}

function Nav() {
  const navigate = useNavigate();
  const u = getUser();
  return (
    <nav className="nav">
      <NavLink to="/" className="brand">REEL<em>SCORE</em></NavLink>
      <div className="nav-links">
        <NavLink to="/" end>Home</NavLink>
        <NavLink to="/search">Search</NavLink>
        <NavLink to="/achievements">Trophies</NavLink>
        <NavLink to="/friends">Friends</NavLink>
        {u && <NavLink to={`/u/${u.username}`}>Me</NavLink>}
        <a
          href="/login"
          onClick={(e) => { e.preventDefault(); clearSession(); navigate("/login"); }}
        >
          Sign out
        </a>
      </div>
    </nav>
  );
}

function Protected({ children }) {
  if (!isAuthed()) return <Navigate to="/login" replace />;
  return (
    <>
      <Nav />
      {children}
      <p className="tmdb-note">
        Film data from TMDB. This product uses the TMDB API but is not endorsed or
        certified by TMDB.
      </p>
    </>
  );
}

export default function App() {
  const [toasts, setToasts] = useState([]);
  const pushToast = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { ...toast, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4500);
  }, []);

  return (
    <ToastCtx.Provider value={pushToast}>
      <BrowserRouter>
        <div className="app">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Protected><Home /></Protected>} />
            <Route path="/search" element={<Protected><Search /></Protected>} />
            <Route path="/movie/:id" element={<Protected><Movie /></Protected>} />
            <Route path="/achievements" element={<Protected><Achievements /></Protected>} />
            <Route path="/friends" element={<Protected><Friends /></Protected>} />
            <Route path="/u/:username" element={<Protected><Profile /></Protected>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <Toasts toasts={toasts} />
        </div>
      </BrowserRouter>
    </ToastCtx.Provider>
  );
}
