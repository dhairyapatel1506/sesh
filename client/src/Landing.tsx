import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { generateRoomId } from "./roomId";
import { SignInButton, useAuth } from "./auth";
import { FriendsPanel, InviteToast } from "./Friends";
import "./App.css";

function Landing() {
  const [joinCode, setJoinCode] = useState("");
  const navigate = useNavigate();
  const { user, loading, enabled, signOut } = useAuth();

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
      <InviteToast />
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

      {/* Sign-in sits below the two things people came here to do, and stays
          out of the way entirely when the server has no accounts configured.
          Nothing here is a gate — it only adds friends on top. */}
      {enabled && !loading && (
        <div className="landing-account">
          {user ? (
            <>
              <p>
                Signed in as <strong>{user.name}</strong> ·{" "}
                <button className="link-button" onClick={() => void signOut()}>
                  sign out
                </button>
              </p>
              <FriendsPanel mode="landing" />
            </>
          ) : (
            <>
              <p className="landing-account-pitch">Sign in to keep a friends list.</p>
              <SignInButton />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default Landing;
