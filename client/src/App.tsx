import { Navigate, Route, Routes } from "react-router-dom";
import Landing from "./Landing";
import LinkTerminal from "./Link";
import Room from "./Room";
import { AuthProvider } from "./auth";

function App() {
  return (
    <AuthProvider>
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
