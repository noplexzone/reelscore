import React, { createContext, useContext, useState, useCallback } from "react";
import { Router, Switch, Route, Link, Redirect, useLocation } from "wouter";
import { isAuthed, clearSession, getUser } from "./api.js";
import Login from "./pages/Login.jsx";
import Home from "./pages/Home.jsx";
import Search from "./pages/Search.jsx";
import Movie from "./pages/Movie.jsx";
import Achievements from "./pages/Achievements.jsx";
import Friends from "./pages/Friends.jsx";
import Profile from "./pages/Profile.jsx";
import Actors from "./pages/Actors.jsx";
import Person from "./pages/Person.jsx";

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

function ActiveLink({ to, exact = false, children, className = "", ...props }) {
  const [location] = useLocation();
  const isActive = exact
    ? location === to
    : location === to || location.startsWith(to + "/");
  const cls = [className, isActive ? "active" : ""].filter(Boolean).join(" ");
  return (
    <Link to={to} className={cls || undefined} {...props}>
      {children}
    </Link>
  );
}

function Nav() {
  const [, navigate] = useLocation();
  const u = getUser();
  return (
    <nav className="nav">
      <ActiveLink to="/" exact className="brand">REEL<em>SCORE</em></ActiveLink>
      <div className="nav-links">
        <ActiveLink to="/" exact>Home</ActiveLink>
        <ActiveLink to="/search">Search</ActiveLink>
        <ActiveLink to="/actors">Actors</ActiveLink>
        <ActiveLink to="/achievements">Trophies</ActiveLink>
        <ActiveLink to="/friends">Friends</ActiveLink>
        {u && <ActiveLink to={`/u/${u.username}`}>Me</ActiveLink>}
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
  if (!isAuthed()) return <Redirect to="/login" />;
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
      <Router>
        <div className="app">
          <Switch>
            <Route path="/login"><Login /></Route>
            <Route path="/search"><Protected><Search /></Protected></Route>
            <Route path="/movie/:id"><Protected><Movie /></Protected></Route>
            <Route path="/actors"><Protected><Actors /></Protected></Route>
            <Route path="/person/:id"><Protected><Person /></Protected></Route>
            <Route path="/achievements"><Protected><Achievements /></Protected></Route>
            <Route path="/friends"><Protected><Friends /></Protected></Route>
            <Route path="/u/:username"><Protected><Profile /></Protected></Route>
            <Route path="/"><Protected><Home /></Protected></Route>
            <Route><Redirect to="/" /></Route>
          </Switch>
          <Toasts toasts={toasts} />
        </div>
      </Router>
    </ToastCtx.Provider>
  );
}
