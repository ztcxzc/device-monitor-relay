const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const url = require("url");

const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL = 30_000; // 30s ping
const STALE_TIMEOUT = 90_000; // drop after 90s no pong

const app = express();
const server = http.createServer(app);

// --- State ---
// pairing_code -> { ws, lastSeen }
const agents = new Map();
// pairing_code -> Set<{ ws, lastSeen }>
const subscribers = new Map();

// --- HTTP health check ---
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    agents: agents.size,
    subscribers: [...subscribers.values()].reduce((n, s) => n + s.size, 0),
  });
});

// --- WebSocket server ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;
  if (pathname === "/agent" || pathname === "/mobile") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === "/agent") {
    handleAgent(ws, req);
  } else if (pathname === "/mobile") {
    handleMobile(ws, req);
  } else {
    ws.close(4004, "Unknown path. Use /agent or /mobile");
  }
});

// --- Agent handler (laptop/PC pushes telemetry) ---
function handleAgent(ws, req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  let pairingCode = null;

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    const str = raw.toString();
    console.log(`[agent][raw] ${str.substring(0, 200)}`);
    let msg;
    try { msg = JSON.parse(str); } catch (e) { console.log(`[agent] parse error: ${e.message}`); return; }

    // First message must be registration
    if (!pairingCode) {
      if (msg.type === "agent_register" && typeof msg.pairing_code === "string") {
        pairingCode = msg.pairing_code.trim();
        if (!pairingCode) { ws.close(4001, "Empty pairing code"); return; }

        // If another agent is already using this code, disconnect the old one
        const existing = agents.get(pairingCode);
        if (existing) {
          try { existing.ws.close(4010, "Replaced by new agent"); } catch {}
        }

        agents.set(pairingCode, { ws, lastSeen: Date.now() });
        ws.send(JSON.stringify({ status: "registered" }));
        console.log(`[agent] registered ${pairingCode} from ${ip}`);
      } else {
        ws.close(4000, "First message must be agent_register");
      }
      return;
    }

    // Telemetry — forward to all subscribers
    if (msg.type === "telemetry" && msg.data) {
      const entry = agents.get(pairingCode);
      if (entry) entry.lastSeen = Date.now();

      const subs = subscribers.get(pairingCode);
      console.log(`[agent] telemetry from ${pairingCode}, subscribers: ${subs ? subs.size : 0}`);
      if (subs && subs.size > 0) {
        const payload = JSON.stringify(msg.data);
        for (const sub of subs) {
          try { sub.ws.send(payload); } catch (e) { console.log(`[agent] send error: ${e.message}`); }
        }
      }
    }
  });

  ws.on("close", () => {
    if (pairingCode) {
      const entry = agents.get(pairingCode);
      if (entry && entry.ws === ws) {
        agents.delete(pairingCode);
        console.log(`[agent] disconnected ${pairingCode}`);
      }
    }
  });
}

// --- Mobile handler (phone subscribes to telemetry) ---
function handleMobile(ws, req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  let pairingCode = null;

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const subEntry = { ws, lastSeen: Date.now() };

  ws.on("message", (raw) => {
    const str = raw.toString();
    console.log(`[mobile][raw] ${str.substring(0, 200)}`);
    let msg;
    try { msg = JSON.parse(str); } catch (e) { console.log(`[mobile] parse error: ${e.message}`); return; }

    // First message must be pairing code (same protocol as direct connect)
    if (!pairingCode) {
      const code = msg.pairing_code?.trim();
      if (!code) {
        ws.close(4000, "Send {pairing_code} first");
        return;
      }

      // Check if agent is online
      if (!agents.has(code)) {
        ws.close(4001, "No agent with that pairing code is online");
        return;
      }

      pairingCode = code;

      // Add to subscribers
      if (!subscribers.has(pairingCode)) {
        subscribers.set(pairingCode, new Set());
      }
      subscribers.get(pairingCode).add(subEntry);

      // Respond with same auth response the direct server uses
      ws.send(JSON.stringify({ status: "authenticated" }));
      console.log(`[mobile] subscribed to ${pairingCode} from ${ip}`);
      return;
    }

    // Commands — forward to agent
    if (msg.command) {
      const agent = agents.get(pairingCode);
      if (agent) {
        try {
          agent.ws.send(JSON.stringify({ type: "command", command: msg.command }));
        } catch {}
      }
    }
  });

  ws.on("close", () => {
    if (pairingCode) {
      const subs = subscribers.get(pairingCode);
      if (subs) {
        subs.delete(subEntry);
        if (subs.size === 0) subscribers.delete(pairingCode);
      }
      console.log(`[mobile] unsubscribed from ${pairingCode}`);
    }
  });
}

// --- Heartbeat: ping all connections, drop stale ones ---
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });

  // Also clean stale agents that stopped sending
  const now = Date.now();
  for (const [code, entry] of agents) {
    if (now - entry.lastSeen > STALE_TIMEOUT) {
      try { entry.ws.close(4008, "Stale"); } catch {}
      agents.delete(code);
      console.log(`[cleanup] stale agent ${code}`);
    }
  }
}, HEARTBEAT_INTERVAL);

// --- Self-ping to prevent Render free-tier spin-down ---
const SELF_PING_INTERVAL = 10 * 60_000; // every 10 minutes
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  fetch(`${url}/`).catch(() => {});
}, SELF_PING_INTERVAL);

// --- Start ---
server.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
