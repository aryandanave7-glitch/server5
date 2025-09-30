const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const cors = require('cors');

const app = express();
app.use(cors()); // Enable CORS for all API routes
app.use(express.json()); // Middleware to parse JSON bodies

// --- START: Modern Database Setup ---
let db;
(async () => {
    try {
        db = await open({
            filename: './syrja.db',
            driver: sqlite3.Database
        });
        await db.run('CREATE TABLE IF NOT EXISTS addresses (address TEXT PRIMARY KEY, inviteCode TEXT NOT NULL)');
        console.log("Database connected and table 'addresses' is ready.");
    } catch (err) {
        console.error("Database connection error: " + err.message);
    }
})();
// --- END: Modern Database Setup ---

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
// --- START: Simple Rate Limiting ---
const rateLimit = new Map();
const LIMIT = 20; // Max 20 requests
const TIME_FRAME = 60 * 1000; // per 60 seconds (1 minute)

function isRateLimited(socket) {
  const ip = socket.handshake.address;
  const now = Date.now();
  const record = rateLimit.get(ip);

  if (!record) {
    rateLimit.set(ip, { count: 1, startTime: now });
    return false;
  }

  // If time window has passed, reset
  if (now - record.startTime > TIME_FRAME) {
    rateLimit.set(ip, { count: 1, startTime: now });
    return false;
  }

  // If count exceeds limit, block the request
  if (record.count >= LIMIT) {
    return true;
  }

  // Otherwise, increment count and allow
  record.count++;
  return false;
}
// --- END: Simple Rate Limiting ---

// just to confirm server is alive
app.get("/", (req, res) => {
  res.send("✅ Signaling server is running");
});

// --- START: Syrja Address API ---

// POST /api/claim - Lets a user claim a unique address (Async/Await version)
app.post("/api/claim", async (req, res) => {
    const { address, inviteCode } = req.body;
    if (!address || !inviteCode) {
        return res.status(400).json({ error: "Address and inviteCode are required." });
    }
    try {
        const sql = `INSERT INTO addresses (address, inviteCode) VALUES (?, ?)`;
        await db.run(sql, [address, inviteCode]);
        res.status(201).json({ success: true, message: "Address claimed successfully." });
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT') {
            return res.status(409).json({ error: "This address is already taken." });
        }
        res.status(500).json({ error: "Database error claiming address." });
    }
});

// GET /api/resolve/:address - Looks up an address and returns the invite code (Async/Await version)
app.get("/api/resolve/:address", async (req, res) => {
    const address = req.params.address;
    try {
        const sql = `SELECT inviteCode FROM addresses WHERE address = ?`;
        const row = await db.get(sql, [address]);
        if (row) {
            res.status(200).json({ success: true, inviteCode: row.inviteCode });
        } else {
            res.status(404).json({ error: "Address not found." });
        }
    } catch (err) {
        res.status(500).json({ error: "Database error resolving address." });
    }
});

// --- END: Syrja Address API ---

// Map a user's permanent pubKey to their temporary socket.id
const userSockets = {};

// Helper to normalize keys
function normKey(k){ return (typeof k === 'string') ? k.replace(/\s+/g,'') : k; }

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Handle client registration
  socket.on("register", (pubKey) => {
    if (isRateLimited(socket)) {
      console.log(`⚠️ Rate limit exceeded for registration by ${socket.handshake.address}`);
      return;
    }
    if (!pubKey) return;
    const key = normKey(pubKey);
    userSockets[key] = socket.id;
    socket.data.pubKey = key; // Store key on socket for later cleanup
    console.log(`🔑 Registered: ${key.slice(0,12)}... -> ${socket.id}`);
  });

  // Handle direct connection requests
  socket.on("request-connection", ({ to, from }) => {
    if (isRateLimited(socket)) {
      console.log(`⚠️ Rate limit exceeded for request-connection by ${socket.handshake.address}`);
      return;
    }
    const targetId = userSockets[normKey(to)];
    if (targetId) {
      io.to(targetId).emit("incoming-request", { from: normKey(from) });
      console.log(`📨 Connection request: ${from.slice(0, 12)}... → ${to.slice(0, 12)}...`);
    } else {
      console.log(`⚠️ Could not deliver request to ${to.slice(0,12)} (not registered/online)`);
    }
  });

  // Handle connection acceptance
  socket.on("accept-connection", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
      io.to(targetId).emit("connection-accepted", { from: normKey(from) });
      console.log(`✅ Connection accepted: ${from.slice(0, 12)}... → ${to.slice(0, 12)}...`);
    } else {
      console.log(`⚠️ Could not deliver acceptance to ${to.slice(0,12)} (not registered/online)`);
    }
  });

  // server.js - New Code
// -- Video/Voice Call Signaling --
socket.on("call-request", ({ to, from, callType }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("incoming-call", { from: normKey(from), callType });
        console.log(`📞 Call request (${callType}): ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-accepted", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-accepted", { from: normKey(from) });
        console.log(`✔️ Call accepted: ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-rejected", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-rejected", { from: normKey(from) });
        console.log(`❌ Call rejected: ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-ended", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-ended", { from: normKey(from) });
        console.log(`👋 Call ended: ${from.slice(0,12)}... & ${to.slice(0,12)}...`);
    }
});
// ---------------------------------


  // Room and signaling logic remains the same
  socket.on("join", (room) => {
    socket.join(room);
    console.log(`Client ${socket.id} joined ${room}`);
  });

  socket.on("signal", ({ room, payload }) => {
    socket.to(room).emit("signal", payload);
  });

  socket.on("auth", ({ room, payload }) => {
    socket.to(room).emit("auth", payload);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    // Clean up the user mapping on disconnect
    if (socket.data.pubKey) {
      delete userSockets[socket.data.pubKey];
      console.log(`🗑️ Unregistered: ${socket.data.pubKey.slice(0, 12)}...`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
