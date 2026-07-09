import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const SERVER_URL = import.meta.env.DEV ? "http://localhost:3001" : "/";
const socket = io(SERVER_URL);

function App() {
  const [connected, setConnected] = useState(socket.connected);
  const [reply, setReply] = useState("");

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onPong = (message: string) => setReply(message);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("pong", onPong);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("pong", onPong);
    };
  }, []);

  return (
    <div className="status-card">
      <h1>Sesh</h1>
      <p>
        Server status:{" "}
        <strong className={connected ? "ok" : "bad"}>
          {connected ? "connected" : "disconnected"}
        </strong>
      </p>
      <button onClick={() => socket.emit("ping", "hello from client")}>
        Ping server
      </button>
      {reply && <p>{reply}</p>}
    </div>
  );
}

export default App;
