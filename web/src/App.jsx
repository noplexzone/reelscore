import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { Router, Switch, Route, Link, Redirect, useLocation } from "wouter";
import { isAuthed, logout, getUser, hydrateSession } from "./api.js";
import Login from "./pages/Login.jsx";
import MfaChallenge from "./pages/MfaChallenge.jsx";
import Settings from "./pages/Settings.jsx";
import VerifyEmail from "./pages/VerifyEmail.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import ResetPassword from "./pages/ResetPassword.jsx";
import ClaimEmail from "./pages/ClaimEmail.jsx";
import Home from "./pages/Home.jsx";
import Search from "./pages/Search.jsx";
import Movie from "./pages/Movie.jsx";
import Achievements from "./pages/Achievements.jsx";
import CuratedLists from "./pages/CuratedLists.jsx";
import CuratedList from "./pages/CuratedList.jsx";
import Friends from "./pages/Friends.jsx";
import Leagues from "./pages/Leagues.jsx";
import Profile from "./pages/Profile.jsx";
import Actors from "./pages/Actors.jsx";
import Person from "./pages/Person.jsx";
import Admin from "./pages/Admin.jsx";
import Duplicates from "./pages/Duplicates.jsx";

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

function Toasts({ toasts }) {
  return <div className="toasts" role="status" aria-live="polite">{toasts.map((t) => (
    <div className="toast" key={t.id}><div className="t-label">{t.label}</div><div className="t-name">{t.name}</div>{t.desc && <div className="muted">{t.desc}</div>}{t.points != null && <div className="t-pts">+{t.points} pts</div>}</div>
  ))}</div>;
}

function ActiveLink({ to, exact = false, children, className = "", ...props }) {
  const [location] = useLocation();
  const active = exact ? location === to : location === to || location.startsWith(to + "/");
  return <Link to={to} className={[className, active ? "active" : ""].filter(Boolean).join(" ") || undefined} {...props}>{children}</Link>;
}

function Nav() {
  const [, navigate] = useLocation();
  const u = getUser();
  async function signOut(e) {
    e.preventDefault();
    await logout();
    navigate("/login");
  }
  return <nav className="nav">
    <ActiveLink to="/" exact className="brand">REEL<em>SCORE</em></ActiveLink>
    <div className="nav-links">
      <ActiveLink to="/" exact>Home</ActiveLink><ActiveLink to="/search">Search</ActiveLink><ActiveLink to="/actors">Actors</ActiveLink><ActiveLink to="/lists">Lists</ActiveLink><ActiveLink to="/achievements">Trophies</ActiveLink><ActiveLink to="/duplicates">Review</ActiveLink><ActiveLink to="/friends">Friends</ActiveLink><ActiveLink to="/leagues">Leagues</ActiveLink>
      {u && <ActiveLink to={`/u/${u.username}`}>Me</ActiveLink>}
      {u && <ActiveLink to="/settings">Settings</ActiveLink>}
      {u && !u.email_verified && <ActiveLink to="/claim-email">Verify email</ActiveLink>}
      {u?.role === "admin" && <ActiveLink to="/admin">Admin</ActiveLink>}
      <a href="/login" onClick={signOut}>Sign out</a>
    </div>
  </nav>;
}

function Protected({ children, admin = false }) {
  if (!isAuthed()) return <Redirect to="/login" />;
  if (admin && getUser()?.role !== "admin") return <Redirect to="/" />;
  return <><Nav />{children}<p className="tmdb-note">Film data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p></>;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState([]);
  useEffect(() => { hydrateSession().finally(() => setReady(true)); }, []);
  const pushToast = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts, { ...toast, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4500);
  }, []);
  if (!ready) return <div className="auth-wrap"><div className="brand">REEL<em>SCORE</em></div><p className="muted">Loading…</p></div>;
  return <ToastCtx.Provider value={pushToast}><Router><div className="app"><Switch>
    <Route path="/login"><Login /></Route>
    <Route path="/mfa"><MfaChallenge /></Route>
    <Route path="/verify-email"><VerifyEmail /></Route>
    <Route path="/forgot-password"><ForgotPassword /></Route>
    <Route path="/reset-password"><ResetPassword /></Route>
    <Route path="/claim-email"><Protected><ClaimEmail /></Protected></Route>
    <Route path="/settings"><Protected><Settings /></Protected></Route>
    <Route path="/search"><Protected><Search /></Protected></Route>
    <Route path="/movie/:id"><Protected><Movie /></Protected></Route>
    <Route path="/actors"><Protected><Actors /></Protected></Route>
    <Route path="/person/:id"><Protected><Person /></Protected></Route>
    <Route path="/achievements"><Protected><Achievements /></Protected></Route>
    <Route path="/lists/:slug"><Protected><CuratedList /></Protected></Route>
    <Route path="/lists"><Protected><CuratedLists /></Protected></Route>
    <Route path="/friends"><Protected><Friends /></Protected></Route>
    <Route path="/leagues/:id"><Protected><Leagues /></Protected></Route>
    <Route path="/leagues"><Protected><Leagues /></Protected></Route>
    <Route path="/join"><Protected><Leagues /></Protected></Route>
    <Route path="/duplicates"><Protected><Duplicates /></Protected></Route>
    <Route path="/u/:username"><Protected><Profile /></Protected></Route>
    <Route path="/admin"><Protected admin><Admin /></Protected></Route>
    <Route path="/"><Protected><Home /></Protected></Route>
    <Route><Redirect to="/" /></Route>
  </Switch><Toasts toasts={toasts} /></div></Router></ToastCtx.Provider>;
}
