// server.js — AirPop Live
const express = require("express");
const http    = require("http");
const path    = require("path");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

// Serve the main app
app.use(express.static(__dirname));

// Serve MediaPipe from local node_modules (avoids CDN flakiness)
app.use("/mediapipe", express.static(path.join(__dirname, "node_modules/@mediapipe/hands")));
app.use("/mediapipe", express.static(path.join(__dirname, "node_modules/@mediapipe/camera_utils")));

// ── Matchmaking ──────────────────────────────────────────────
let waitingUser = null;
const rooms = {};

function generateRoomId() {
  return "room-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("find-peer", () => {
    if (waitingUser && waitingUser.id !== socket.id) {
      const roomId = generateRoomId();
      const peer   = waitingUser;
      waitingUser  = null;

      rooms[roomId] = [peer.id, socket.id];
      peer.join(roomId);
      socket.join(roomId);
      peer.roomId   = roomId;
      socket.roomId = roomId;

      peer.emit("matched",   { roomId, initiator: true,  peerId: socket.id });
      socket.emit("matched", { roomId, initiator: false, peerId: peer.id   });
      console.log(`Matched: ${peer.id} <-> ${socket.id} in ${roomId}`);
    } else {
      waitingUser = socket;
      socket.emit("waiting");
      console.log(`Waiting: ${socket.id}`);
    }
  });

  socket.on("cancel-search", () => {
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    socket.emit("search-cancelled");
  });

  socket.on("offer",         ({ to, offer })      => io.to(to).emit("offer",         { from: socket.id, offer }));
  socket.on("answer",        ({ to, answer })     => io.to(to).emit("answer",        { from: socket.id, answer }));
  socket.on("ice-candidate", ({ to, candidate })  => io.to(to).emit("ice-candidate", { from: socket.id, candidate }));

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      io.to(roomId).emit("peer-left");
      delete rooms[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AirPop Live running on http://localhost:${PORT}`));