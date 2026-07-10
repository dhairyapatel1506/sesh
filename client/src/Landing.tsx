import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { generateRoomId } from "./roomId";
import "./App.css";

function Landing() {
  const [joinCode, setJoinCode] = useState("");
  const navigate = useNavigate();

  const handleCreate = () => {
    navigate(`/room/${generateRoomId()}`);
  };

  const handleJoin = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    navigate(`/room/${code}`);
  };

  return (
    <div className="app">
      <header>
        <h1>Sesh</h1>
      </header>

      <div className="landing-actions">
        <button onClick={handleCreate}>Create a room</button>

        <div className="landing-divider">or</div>

        <div className="load-bar">
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="Enter a room code"
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          />
          <button onClick={handleJoin}>Join</button>
        </div>
      </div>
    </div>
  );
}

export default Landing;
