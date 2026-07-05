/**
 * The console shell (ADR-0032): boot config → finish any OAuth callback → require
 * a signed-in identity → hash-routed views. Routing is a window.location.hash
 * switch — three views don't need a router dependency.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadConfig, type ConsoleConfig } from "./config";
import { completeLoginIfCallback, currentIdentity, login, logout, type Identity } from "./auth";
import { Api } from "./api";
import { RunsView } from "./views/RunsView";
import { RunDetailView } from "./views/RunDetailView";
import { NewRunView } from "./views/NewRunView";
import { BudgetPanel } from "./views/BudgetPanel";

type Route = { view: "runs" } | { view: "run"; id: string } | { view: "new" };

function parseRoute(hash: string): Route {
  const m = hash.match(/^#\/runs\/([^/]+)$/);
  if (m) return { view: "run", id: m[1]! };
  if (hash === "#/new") return { view: "new" };
  return { view: "runs" };
}

export function App() {
  const [cfg, setCfg] = useState<ConsoleConfig | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const c = await loadConfig();
        await completeLoginIfCallback(c);
        setCfg(c);
        setIdentity(currentIdentity());
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // an expired token surfaces as a 401 from the API — drop back to sign-in
  const onUnauthorized = useCallback(() => setIdentity(null), []);

  const api = useMemo(() => (cfg && identity ? new Api(cfg, identity.token) : null), [cfg, identity]);

  if (bootError) {
    return (
      <div className="gatehouse">
        <div className="card">
          <span className="wordmark">
            agent<em>-os</em>
          </span>
          <p className="error">{bootError}</p>
        </div>
      </div>
    );
  }
  if (!cfg) return null;

  if (!identity || !api) {
    return (
      <div className="gatehouse">
        <div className="card">
          <span className="wordmark">
            agent<em>-os</em>
            <small>console</small>
          </span>
          <p>Launch governed agent runs and watch them turn by turn. Sign in with your platform account to continue.</p>
          <button className="button" onClick={() => login(cfg)}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="rail">
        <span className="wordmark">
          agent<em>-os</em>
          <small>console</small>
        </span>
        <nav>
          <a href="#/runs" aria-current={route.view !== "new" ? "page" : undefined}>
            Runs
          </a>
          <a href="#/new" aria-current={route.view === "new" ? "page" : undefined}>
            New run
          </a>
        </nav>
        <div className="spacer" />
        <BudgetPanel api={api} tenant={identity.tenant} />
        <div className="whoami">
          <span>
            {identity.subject}
            <span className="tenant"> · {identity.tenant}</span>
          </span>
          <button onClick={() => logout(cfg)}>Sign out</button>
        </div>
      </aside>
      <main>
        {route.view === "runs" && <RunsView api={api} onUnauthorized={onUnauthorized} />}
        {route.view === "run" && <RunDetailView api={api} id={route.id} onUnauthorized={onUnauthorized} />}
        {route.view === "new" && <NewRunView api={api} onUnauthorized={onUnauthorized} />}
      </main>
    </div>
  );
}
