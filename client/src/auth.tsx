import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { API_BASE, socket } from "./socket";

export type User = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  friendCode: string;
};

type AuthValue = {
  user: User | null;
  // Distinguishes "not signed in" from "don't know yet" — without it every
  // page flashes its signed-out state for a moment on load.
  loading: boolean;
  // False when the server has no database or no Google client configured, in
  // which case nothing about accounts should be shown at all.
  enabled: boolean;
  clientId: string | null;
  setUser: (user: User | null) => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthValue>({
  user: null,
  loading: true,
  enabled: false,
  clientId: null,
  setUser: () => {},
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientId, setClientId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Both together: what sign-in is available, and whether we're already
    // signed in. One render, not two.
    Promise.all([
      fetch(`${API_BASE}/api/auth/config`).then((r) => r.json()),
      fetch(`${API_BASE}/api/auth/me`, { credentials: "include" }).then((r) => r.json()),
    ])
      .then(([config, me]) => {
        if (cancelled) return;
        setClientId(config?.enabled ? config.clientId : null);
        setUser(me?.user ?? null);
      })
      .catch(() => {
        // Offline or an older server — behave exactly like signed out.
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // The server reads who you are from the cookie on the socket's *handshake*,
  // which happened when the page loaded — before you signed in. Until that
  // connection is replaced it stays anonymous, so nothing addressed to you
  // arrives: friends appear only on refresh, and nobody sees you as online.
  // Reconnecting redoes the handshake, now with the cookie.
  const reidentify = () => {
    socket.disconnect();
    socket.connect();
  };

  const signIn = (next: User | null) => {
    setUser(next);
    reidentify();
  };

  const signOut = async () => {
    await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: "include" }).catch(
      () => {},
    );
    setUser(null);
    // Same in reverse: the socket would otherwise keep announcing a presence
    // that belongs to someone who just signed out.
    reidentify();
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, enabled: clientId !== null, clientId, setUser: signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// Google's script is only fetched for people who might actually use it — it
// isn't in index.html, so a signed-out visitor with sign-in disabled loads
// nothing from Google at all.
let scriptPromise: Promise<void> | null = null;
function loadGoogleScript(): Promise<void> {
  return (scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null; // let a later attempt retry
      reject(new Error("couldn't load Google sign-in"));
    };
    document.head.appendChild(script);
  }));
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

export function SignInButton() {
  const { clientId, setUser } = useAuth();
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !holder.current) return;
    let cancelled = false;

    loadGoogleScript()
      .then(() => {
        if (cancelled || !holder.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async ({ credential }) => {
            try {
              const res = await fetch(`${API_BASE}/api/auth/google`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ credential }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data?.error ?? "sign-in failed");
              setUser(data.user);
            } catch (err) {
              setError((err as Error).message);
            }
          },
        });
        window.google.accounts.id.renderButton(holder.current, {
          theme: "outline",
          size: "large",
          shape: "pill",
          text: "signin_with",
        });
      })
      .catch((err) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
    };
  }, [clientId, setUser]);

  if (!clientId) return null;
  return (
    <div className="sign-in">
      <div ref={holder} />
      {error && <p className="load-error">{error}</p>}
    </div>
  );
}
