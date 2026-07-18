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
    <div className="app landing">
      <img src="/logo.png" alt="" className="landing-logo" />
      <h1>Sesh</h1>
      <p className="tagline">Watch YouTube with your friends, perfectly in sync.</p>

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
