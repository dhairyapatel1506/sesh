import { Navigate, Route, Routes } from "react-router-dom";
import Landing from "./Landing";
import Room from "./Room";

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/room/:roomId" element={<Room />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
