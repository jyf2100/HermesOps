import { useState, useCallback, useEffect } from "react";
import { Outlet, Navigate, useLocation, Link, NavLink } from "react-router-dom";
import { useI18n } from "../hooks/useI18n";
import { getAuthMode, adminApi } from "../lib/admin-api";
import { AdminApiError } from "../lib/admin-api";

/* ── Inline icon components (no external deps) ── */

function IconDashboard({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function IconSettings({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconMenu({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function IconX({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconLogout({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function IconFolder({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  );
}

function IconChat({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 011.037-.443 48.282 48.282 0 005.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
    </svg>
  );
}

function IconTemplate({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function IconTerminal({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function IconPlus({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 4v16m8-8H4" />
    </svg>
  );
}

/* ── Navigation items ── */

interface NavItem {
  to: string;
  label: string;
  icon: typeof IconDashboard;
  href?: string; // external link
}

/* ── Component ── */

export function AdminLayout() {
  const { t, lang, setLang } = useI18n();
  const location = useLocation();
  const authMode = getAuthMode();
  const isUser = authMode === "user" || authMode === "email";

  // Auth check: user/email mode uses token, admin mode uses key
  const adminKey = localStorage.getItem("admin_api_key");
  const userToken = localStorage.getItem("admin_user_token") || localStorage.getItem("admin_email_token");
  const isAuthenticated = isUser ? !!userToken : !!adminKey;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Escape key closes mobile drawer
  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [drawerOpen]);

  // Lock body scroll when mobile drawer is open
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen]);

  /* Auth guard */
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  const storedAgentId = parseInt(localStorage.getItem("admin_user_agent_id") || "0", 10)
  const opsPanelUrl = storedAgentId > 0 ? `${window.location.origin}/agent${storedAgentId}/ops/` : "#"

  const navItems: NavItem[] = isUser
    ? [
        { to: "/", label: t.navDashboard, icon: IconDashboard },
        { to: "/files", label: t.fileBrowser, icon: IconFolder },
        { to: "/chat", label: t.startChat, icon: IconChat },
        ...(storedAgentId > 0 ? [{ to: "#", label: t.navAgentPanel, icon: IconTerminal, href: opsPanelUrl }] : []),
      ]
    : [
        { to: "/", label: t.navDashboard, icon: IconDashboard },
        { to: "/create", label: t.navCreateAgent, icon: IconPlus },
        { to: "/templates", label: t.templateNav, icon: IconTemplate },
        { to: "/settings", label: t.navSettings, icon: IconSettings },
      ];

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/" || location.pathname.startsWith("/agents/");
    return location.pathname.startsWith(path);
  };

  async function handleLogout() {
    if (isUser) {
      await adminApi.userLogout();
      localStorage.removeItem("admin_user_token");
      localStorage.removeItem("admin_email_token");
      localStorage.removeItem("admin_user_agent_id");
      localStorage.removeItem("admin_user_display_name");
    } else {
      localStorage.removeItem("admin_api_key");
    }
    localStorage.removeItem("admin_mode");
    window.location.href = "/admin/";
  }

  // In user mode, redirect /settings and /create to /
  if (isUser) {
    if (location.pathname === "/settings" || location.pathname === "/create") {
      return <Navigate to="/" replace />;
    }
  }

  const userDisplayName = localStorage.getItem("admin_user_display_name") || "";

  /* ── Sidebar content (shared between desktop and mobile drawer) ── */
  function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
    return (
      <div className="flex flex-col h-full">
        {/* Brand */}
        <div className="px-5 py-4 shrink-0 border-b border-border-subtle">
          <h1 className="font-[family-name:var(--font-display)] text-base font-bold tracking-[0.12em] text-accent-pink/80">
            NEWHERMES
          </h1>
          {isUser && userDisplayName && (
            <p className="mt-1 text-xs text-text-secondary truncate" title={userDisplayName}>
              {userDisplayName}
            </p>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 mt-2 space-y-1" aria-label="Main navigation">
          {navItems.map((item) => {
            const active = !item.href && isActive(item.to);
            const Icon = item.icon;

            if (item.href && item.href !== "#") {
              return (
                <a
                  key={item.to}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface/50 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]"
                >
                  <Icon className="w-[18px] h-[18px] shrink-0" />
                  <span>{item.label}</span>
                  <svg viewBox="0 0 20 20" className="w-3 h-3 ml-auto opacity-40" fill="currentColor" aria-hidden="true">
                    <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                    <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                  </svg>
                </a>
              );
            }

            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                className={[
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors duration-150 relative focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]",
                  active
                    ? "text-text-primary font-medium bg-accent-pink/10"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface/50",
                ].join(" ")}
                aria-current={active ? "page" : undefined}
              >
                {active && (
                  <span
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-accent-pink"
                    aria-hidden="true"
                  />
                )}
                <Icon className="w-[18px] h-[18px] shrink-0" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Orchestrator section — admin only */}
        {!isUser && (
          <div className="mt-4 mx-3 rounded-lg bg-surface/40 border border-border-subtle p-3">
            <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2 px-2">
              {t.orchestratorNav}
            </p>
            <NavLink
              to="/orchestrator"
              onClick={onNavigate}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors duration-150 relative focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]",
                  isActive
                    ? "text-text-primary font-medium bg-accent-pink/10"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface/50",
                ].join(" ")
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-accent-pink"
                      aria-hidden="true"
                    />
                  )}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-[18px] h-[18px] shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                  </svg>
                  <span>{t.orchestratorOverview}</span>
                </>
              )}
            </NavLink>
            <NavLink
              to="/orchestrator/tasks/new"
              onClick={onNavigate}
              className={({ isActive }) =>
                [
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors duration-150 relative focus-visible:outline-2 focus-visible:outline-accent-cyan focus-visible:outline-offset-[-2px]",
                  isActive
                    ? "text-text-primary font-medium bg-accent-pink/10"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface/50",
                ].join(" ")
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span
                      className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-accent-pink"
                      aria-hidden="true"
                    />
                  )}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-[18px] h-[18px] shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 4v16m8-8H4" />
                  </svg>
                  <span>{t.orchestratorNewTask}</span>
                </>
              )}
            </NavLink>
          </div>
        )}

        {/* Bottom section */}
        <div className="mt-auto border-t border-border-subtle pt-3 px-3 pb-4 space-y-2 shrink-0">
          {/* Web Chat external link — admin only */}
          {!isUser && (
            <a
              href={window.location.origin}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface/50 transition-colors duration-150 border border-border-subtle"
            >
              <IconChat className="w-3.5 h-3.5 shrink-0" />
              <span>{t.navWebui}</span>
              <svg viewBox="0 0 20 20" className="w-3 h-3 ml-auto opacity-40" fill="currentColor" aria-hidden="true">
                <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
              </svg>
            </a>
          )}

          {/* User mode badge */}
          {isUser && (
            <div className="px-3 py-2 rounded-md border border-accent-cyan/30 bg-accent-cyan/5">
              <p className="text-xs text-accent-cyan font-medium">
                {t.userMode}
              </p>
            </div>
          )}

          {/* Cluster status — admin only */}
          {!isUser && (
            <div className="px-3 py-2 rounded-md border border-border-subtle bg-surface/30">
              <p className="text-xs text-text-secondary font-[family-name:var(--font-mono)]">
                {t.clusterStatus}
              </p>
            </div>
          )}

          {/* Language toggle */}
          <button
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            className="w-full flex items-center justify-center h-7 px-3 text-xs rounded-full border border-accent-cyan text-accent-cyan transition-colors duration-150 hover:bg-accent-cyan/10"
          >
            {t.languageSwitch}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen h-screen flex bg-background text-text-primary overflow-hidden">
      {/* ── Desktop sidebar ── */}
      <aside
        className="hidden md:flex md:flex-col md:w-56 shrink-0 bg-sidebar-bg border-r border-accent-pink/20"
        aria-label="Sidebar navigation"
      >
        <SidebarContent />
      </aside>

      {/* ── Mobile drawer backdrop ── */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={closeDrawer}
          aria-hidden="true"
        />
      )}

      {/* ── Mobile sidebar drawer ── */}
      <aside
        className={[
          "fixed inset-y-0 left-0 z-50 w-56 bg-sidebar-bg border-r border-accent-pink/20 md:hidden transition-transform duration-300 ease-out",
          drawerOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
        aria-label="Mobile navigation"
        aria-hidden={!drawerOpen}
      >
        {/* Close button */}
        <div className="absolute top-3 right-3">
          <button
            onClick={closeDrawer}
            className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface/50 transition-colors"
            aria-label="Close navigation menu"
          >
            <IconX className="w-4 h-4" />
          </button>
        </div>
        <SidebarContent onNavigate={closeDrawer} />
      </aside>

      {/* ── Main area ── */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Topbar */}
        <header className="glass h-14 shrink-0 flex items-center justify-between px-4 border-b border-border-subtle z-30">
          {/* Left: mobile hamburger */}
          <button
            onClick={() => setDrawerOpen(true)}
            className="md:hidden p-2 -ml-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface/50 transition-colors"
            aria-label="Open navigation menu"
          >
            <IconMenu className="w-5 h-5" />
          </button>

          {/* User display name in topbar for user mode */}
          {isUser && userDisplayName && (
            <span className="hidden md:inline text-sm text-text-secondary">
              {userDisplayName}
            </span>
          )}

          {/* Spacer to push logout right on desktop */}
          <div className="hidden md:block" />

          {/* Right: logout */}
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-surface/50 transition-colors"
          >
            <IconLogout className="w-4 h-4" />
            <span className="hidden sm:inline">{t.logout}</span>
          </button>
        </header>

        {/* Content */}
        <main className="flex-1 min-h-0 overflow-auto relative">
          <div className="p-4 md:p-6 max-w-7xl mx-auto w-full animate-page-enter">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
