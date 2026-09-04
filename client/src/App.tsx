import { Navigate, Route, Routes } from "react-router-dom";
import Landing from "./Landing";
import LinkTerminal from "./Link";
import Room from "./Room";
import { AuthProvider } from "./auth";
import { useEffect, useState } from "react";
import { API_BASE } from "./socket";

// A corner badge on every page of a staging deploy, so nobody mistakes a test
// site for the real one (or the other way round). Production shows nothing.
function EnvBadge() {
  const [env, setEnv] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${API_BASE}/api/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { env?: string } | null) => setEnv(data?.env ?? null))
      .catch(() => {});
  }, []);
  if (env !== "staging") return null;
  return (
    <span className="env-badge" title="This is the staging site — for testing changes before they go live">
      staging
    </span>
  );
}

function App() {
  return (
    <AuthProvider>
      <EnvBadge />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/room/:roomId" element={<Room />} />
        <Route path="/link" element={<LinkTerminal />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
