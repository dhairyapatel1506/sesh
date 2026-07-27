import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { API_BASE } from "./socket";
import { SignInButton, useAuth } from "./auth";
import "./App.css";

// Codes are shown as ABCD-EFGH and typed however people feel like — with the
// dash, without it, in lowercase off a screenshot. The server normalises the
// same way; this is only so the box shows back what the terminal printed.
function formatCode(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

function LinkTerminal() {
  const { user, loading, enabled } = useAuth();
  const [params] = useSearchParams();
  // A code in the URL fills the box and stops there. Approving on load would
  // turn a link someone sends you into a signed-in terminal you never saw.
  const [code, setCode] = useState(() => formatCode(params.get("code") ?? ""));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const approve = async () => {
    if (!code || working) return;
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/cli/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "that didn't work");
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="app link-page">
      <header>
        <h1>
          <Link to="/">
            <img src="/logo.png" alt="" className="logo-mark" />
            Sesh
          </Link>
        </h1>
      </header>

      <h2>Link a terminal</h2>

      {loading ? null : !enabled ? (
        <p className="link-lead">This server has no accounts, so there's nothing to link to.</p>
      ) : !user ? (
        <>
          <p className="link-lead">
            Running <code>sesh</code> in a terminal? It prints a short code and waits here for you to
            say it's yours. Sign in first — the terminal ends up signed in as whoever approves it.
          </p>
          <SignInButton />
        </>
      ) : done ? (
        <div className="link-done">
          <p className="link-lead">
            Done — your terminal is signed in as <strong>{user.name}</strong>. You can close this
            page; it'll pick the session up on its own within a few seconds.
          </p>
        </div>
      ) : (
        <>
          <p className="link-lead">
            Enter the code your terminal is showing. It'll be signed in as{" "}
            <strong>{user.name}</strong> ({user.email}).
          </p>

          {/* The whole risk in a device-code flow, stated where the decision is
              made. There's no way for this page to tell whose terminal a code
              came from — only the person reading it can. */}
          <p className="link-warning">
            Only approve a code you can see in your own terminal. Approving someone else's code
            signs <em>their</em> terminal into <em>your</em> account, with your friends and your
            messages.
          </p>

          <div className="load-bar link-bar">
            <input
              value={code}
              onChange={(e) => {
                setCode(formatCode(e.target.value));
                if (error) setError(null);
              }}
              placeholder="ABCD-EFGH"
              className="link-code"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && void approve()}
            />
            <button onClick={() => void approve()} disabled={!code || working}>
              {working ? "Linking…" : "Link terminal"}
            </button>
          </div>

          {error && <p className="load-error">{error}</p>}
          <p className="link-note">Codes last ten minutes and work once.</p>
        </>
      )}
    </div>
  );
}

export default LinkTerminal;
