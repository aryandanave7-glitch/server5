const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const cors = require('cors');

// This main function contains our entire server logic to prevent race conditions.
async function main() {
    // --- 1. Database Setup ---
    // This waits until the database is ready before any other code runs.
    const db = await open({
        filename: './syrja.db',
        driver: sqlite3.Database
    });
    await db.run('CREATE TABLE IF NOT EXISTS addresses (address TEXT PRIMARY KEY, inviteCode TEXT NOT NULL)');
    console.log("Database connected and table 'addresses' is ready.");

    // --- 2. Express & Server Setup ---
    const app = express();
    app.use(cors()); // Enable CORS for all API routes
    app.use(express.json()); // Middleware to parse JSON bodies

    const server = http.createServer(app);
    const io = new Server(server, {
      cors: { origin: "*" }
    });

    // --- 3. API Routes ---

    // Health check route
    app.get("/", (req, res) => {
      res.send("✅ Signaling server is running");
    });

    // POST /api/claim - Lets a user claim a unique address
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

    // GET /api/resolve/:address - Looks up an address and returns the invite code
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

    // --- 4. Rate Limiting and Socket.IO Logic ---
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
      if (now - record.startTime > TIME_FRAME) {
        rateLimit.set(ip, { count: 1, startTime: now });
        return false;
      }
      if (record.count >= LIMIT) {
        return true;
      }
      record.count++;
      return false;
    }

    const userSockets = {};
    function normKey(k){ return (typeof k === 'string') ? k.replace(/\s+/g,'') : k; }

    io.on("connection", (socket) => {
        console.log("Client connected:", socket.id);

        socket.on("register", (pubKey) => {
            if (isRateLimited(socket)) {
              console.log(`⚠️ Rate limit exceeded for registration by ${socket.handshake.address}`);
              return;
            }
            if (!pubKey) return;
            const key = normKey(pubKey);
            userSockets[key] = socket.id;
            socket.data.pubKey = key;
            console.log(`🔑 Registered: ${key.slice(0,12)}... -> ${socket.id}`);
        });

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

        socket.on("accept-connection", ({ to, from }) => {
            const targetId = userSockets[normKey(to)];
            if (targetId) {
              io.to(targetId).emit("connection-accepted", { from: normKey(from) });
              console.log(`✅ Connection accepted: ${from.slice(0, 12)}... → ${to.slice(0, 12)}...`);
            } else {
              console.log(`⚠️ Could not deliver acceptance to ${to.slice(0,12)} (not registered/online)`);
            }
        });

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
            if (socket.data.pubKey) {
              delete userSockets[socket.data.pubKey];
              console.log(`🗑️ Unregistered: ${socket.data.pubKey.slice(0, 12)}...`);
            }
        });
    });

    // --- 5. Server Startup ---
    // This now happens last, only after everything above is configured.
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

// Run the main function and catch any errors during startup.
main().catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
