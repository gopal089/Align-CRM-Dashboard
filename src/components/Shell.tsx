import { useEffect, useState, useRef } from "react";
import {
  NavLink,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Search,
  Plus,
  ChevronDown,
  ArrowUpRight,
  Menu as MenuIcon,
  X,
  Check,
  Command,
  LifeBuoy,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "../lib/client";
import { useAuth } from "../lib/auth";
import { nav, entities } from "../lib/model";
import { cleanSearch, date, initials } from "../lib/utils";
import { Logo, Modal, Menu, Empty, ErrorMessage } from "./ui";
import { useSummary } from "../lib/data";
import { BillingNotice } from "./Billing";
export default function Shell() {
  const { org, role, profile, session } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobile, setMobile] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia("(max-width: 720px)").matches,
  );
  const sidebarRef = useRef<HTMLElement>(null);
  const navTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setIsMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (isMobile && mobile)
      sidebarRef.current
        ?.querySelector<HTMLButtonElement>(".sidebar-close")
        ?.focus();
    else if (drawerWasOpen.current) navTriggerRef.current?.focus();
    drawerWasOpen.current = isMobile && mobile;
  }, [mobile, isMobile]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [notifications, setNotifications] = useState(false);
  const [help, setHelp] = useState(false);
  const { data: summary } = useSummary("all");
  useEffect(() => {
    setMobile(false);
  }, [location.pathname]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(cleanSearch(search)), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  const results = useQuery({
    queryKey: ["global-search", org?.id, debounced],
    enabled: debounced.length >= 2,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("global_search", {
        o: org!.id,
        term: debounced,
      });
      if (error) throw error;
      return data as { id: string; name: string; kind: string }[];
    },
  });
  const current =
    nav.find((x) => location.pathname.startsWith(x.path))?.name || "Workspace";
  const due =
    profile?.notifications === false ? [] : summary?.notifications || [];
  return (
    <div className="app-shell">
      {mobile && (
        <button
          className="nav-overlay"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        className={`sidebar ${mobile ? "sidebar-open" : ""}`}
        ref={sidebarRef}
        inert={isMobile && !mobile}
        role={isMobile ? "dialog" : undefined}
        aria-modal={isMobile && mobile ? true : undefined}
        aria-label="Workspace navigation"
        onKeyDown={(e) => {
          if (!isMobile || !mobile) return;
          if (e.key === "Escape") {
            e.preventDefault();
            setMobile(false);
          }
          if (e.key === "Tab") {
            const items = Array.from(
              sidebarRef.current!.querySelectorAll<HTMLElement>(
                "a[href],button:not([disabled]),select",
              ),
            ).filter((el) => el.offsetParent !== null);
            const first = items[0],
              last = items.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <button
          className="icon-button sidebar-close"
          aria-label="Close navigation drawer"
          onClick={() => setMobile(false)}
        >
          <X size={18} />
        </button>
        <Link
          to="/dashboard"
          className="logo-link"
          aria-label="Align home"
          onClick={() => setMobile(false)}
        >
          <Logo />
        </Link>
        <button
          className="workspace-switch"
          onClick={() => navigate("/settings")}
        >
          <span className="workspace-avatar">{initials(org!.name)}</span>
          <span>
            <strong>{org!.name}</strong>
            <small>Sales workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-section-label">WORKSPACE</div>
        <nav>
          {nav.slice(0, 9).map((n) => (
            <NavLink
              to={n.path}
              onClick={() => setMobile(false)}
              key={n.path}
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <n.icon size={18} />
              <span>{n.name}</span>
              {n.path === "/tasks" && due.length > 0 && (
                <small>{due.length}</small>
              )}
            </NavLink>
          ))}
          <div className="nav-divider" />
          {nav.slice(9).map((n) => (
            <NavLink
              to={n.path}
              onClick={() => setMobile(false)}
              key={n.path}
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <n.icon size={18} />
              <span>{n.name}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-note">
            <span className="tiny-label">A CLEARER WAY FORWARD</span>
            <p>
              Great relationships
              <br />
              start with a conversation.
            </p>
            <Link to="/leads?new=1">
              Add your first connection <ArrowUpRight size={14} />
            </Link>
          </div>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <LifeBuoy size={18} />
            Help & getting started
            <ArrowUpRight size={13} />
          </button>
          <div className="sidebar-user">
            <span className="avatar">
              {initials(profile?.name || session!.user.email || "You")}
            </span>
            <div>
              <strong>{profile?.name || session!.user.email}</strong>
              <small>{role}</small>
            </div>
            <Menu
              items={[
                {
                  label: "Profile & preferences",
                  action: () => navigate("/settings?tab=profile"),
                },
                {
                  label: "Sign out",
                  action: async () => {
                    const { error } = await supabase.auth.signOut();
                    if (error) toast.error(error.message);
                  },
                },
              ]}
            />
          </div>
        </div>
      </aside>
      <div className="main-shell" inert={isMobile && mobile}>
        <header className="topbar">
          <div className="topbar-context">
            <button
              ref={navTriggerRef}
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobile(!mobile)}
            >
              {mobile ? <X size={19} /> : <MenuIcon size={19} />}
            </button>
            <span className="header-workspace">Workspace</span>
            <span className="slash">/</span>
            <strong>{current}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="global-search"
              aria-label="Search workspace"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={16} />
              <span>Search anything...</span>
              <kbd>⌘ K</kbd>
            </button>
            <span className="header-divider" />
            <Menu
              label="Create"
              items={[
                "lead",
                "contact",
                "company",
                "deal",
                "pitch",
                "task",
                "activity",
              ].map((label) => ({
                label: `New ${label}`,
                action: () => {
                  const entity = Object.values(entities).find(
                    (x) => x.singular === label,
                  )!;
                  navigate(`/${entity.key}?new=1`);
                },
              }))}
            >
              <Plus size={17} />
              Create
            </Menu>
            <button
              className="icon-button notification-button"
              aria-label="Notifications"
              onClick={() => setNotifications(true)}
            >
              <Bell size={18} />
              {due.length > 0 && <i />}
            </button>
            <button
              className="avatar small"
              onClick={() => navigate("/settings?tab=profile")}
              aria-label="Your profile"
            >
              {initials(profile?.name || "You")}
            </button>
          </div>
        </header>
        <main className="page-content" key={org?.id}>
          <BillingNotice />
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>Align CRM</span>
          <span>Built around better relationships.</span>
          <span className="connection">
            <i />
            Connected to Supabase
          </span>
        </footer>
      </div>
      <Modal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        title="Search your workspace"
        description="Search leads, contacts, companies, deals, and pitches."
      >
        <div className="search-field">
          <Search size={18} />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type at least 2 characters..."
            aria-label="Global search"
          />
          <Command size={15} />
        </div>
        {results.error && (
          <ErrorMessage error={(results.error as Error).message} />
        )}
        {results.isFetching ? (
          <p className="muted">Searching…</p>
        ) : debounced.length >= 2 && !results.data?.length ? (
          <Empty
            compact
            title="No matching records"
            description="Try another name, company, or email address."
          />
        ) : (
          <div className="search-results">
            {results.data?.map((r) => (
              <button
                key={r.kind + r.id}
                onClick={() => {
                  navigate(`/${r.kind}/${r.id}`);
                  setSearchOpen(false);
                }}
              >
                <span>
                  <strong>{r.name}</strong>
                  <small>
                    {r.kind === "pitch-desk"
                      ? "Pitch"
                      : entities[r.kind]?.singular}
                  </small>
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))}
          </div>
        )}
      </Modal>
      <Modal
        open={notifications}
        onClose={() => setNotifications(false)}
        title="Your reminders"
        description="Open tasks due today or earlier. These reminders come from your saved tasks."
      >
        {profile?.notifications === false ? (
          <Empty
            compact
            title="Reminders are turned off"
            description="Enable them in your profile preferences."
          />
        ) : !due.length ? (
          <Empty
            compact
            title="You’re all caught up"
            description="Your open tasks due today or earlier will appear here."
          />
        ) : (
          due.map((t: any) => (
            <button
              className="reminder-row"
              key={t.id}
              onClick={() => {
                navigate(`/tasks/${t.id}`);
                setNotifications(false);
              }}
            >
              <Check size={17} />
              <span>
                <strong>{t.name}</strong>
                <small>Due {date(t.due_date, org!.timezone)}</small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))
        )}
        <p className="fine-print">
          In-app reminders only. Email and push notifications are not
          configured.
        </p>
      </Modal>
      <Modal
        open={help}
        onClose={() => setHelp(false)}
        title="A good place to start"
        description="Build your pipeline one real relationship at a time."
      >
        <div className="help-steps">
          {[
            ["1", "Add a company and a contact", "/contacts"],
            ["2", "Capture and qualify a lead", "/leads"],
            [
              "3",
              "Convert a qualified lead to a deal",
              "/leads?status=Qualified",
            ],
            ["4", "Create a proposal in Pitch Desk", "/pitch-desk"],
            ["5", "Set a target and review performance", "/targets"],
          ].map(([n, label, to]) => (
            <Link key={n} to={to} onClick={() => setHelp(false)}>
              <span>{n}</span>
              {label}
              <ArrowUpRight size={15} />
            </Link>
          ))}
        </div>
        <p className="fine-print">
          Customer email, automatic view tracking, and payment provider
          synchronization require external integrations. Recorded actions are
          manual.
        </p>
      </Modal>
    </div>
  );
}
