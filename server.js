const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

// ---------------------- EXPRESS + STATIC ----------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------------- SERVER STATE --------------------------

let nextClientId = 1;
const clients = new Map();   // Map<ws, client>
const rooms   = new Map();   // Map<code, room>

// room = {
//   code,
//   hostId,
//   status: "lobby" | "playing" | "finished",
//   round,
//   targetPlayers: number | null (optional),
//   players: [{ id, name, client, lockedWord, lastWord }]
// };

// ---------------------- UTILITIES -----------------------------

function send(ws, payload) {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload) {
  for (const p of room.players) {
    send(p.client.ws, payload);
  }
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    round: room.round,
    targetPlayers: room.targetPlayers ?? room.players.length,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      locked: !!p.lockedWord,
      lastWord: p.lastWord || null
    }))
  };
}

function broadcastRoomUpdate(room) {
  broadcast(room, {
    type: "room_update",
    room: serializeRoom(room)
  });
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  while (!code || rooms.has(code)) {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return code;
}

function getRoomFor(client) {
  return client.roomCode ? rooms.get(client.roomCode) || null : null;
}

function addClientToRoom(client, room) {
  const exists = room.players.find(p => p.id === client.id);
  if (exists) return;

  room.players.push({
    id: client.id,
    name: client.name || "Player",
    client,            // client has ws attached
    lockedWord: null,
    lastWord: null
  });

  client.roomCode = room.code;
  broadcastRoomUpdate(room);
}

function removeClientFromRoom(client) {
  const room = getRoomFor(client);
  if (!room) {
    client.roomCode = null;
    return;
  }

  room.players = room.players.filter(p => p.id !== client.id);

  if (room.players.length === 0) {
    rooms.delete(room.code);
  } else {
    if (room.hostId === client.id) {
      room.hostId = room.players[0].id; // promote first player as host
    }
    broadcastRoomUpdate(room);
  }

  client.roomCode = null;
}

// ---------------------- GAME LOGIC ----------------------------

function resolveRound(room) {
  const words = room.players.map(p => p.lockedWord || "");
  if (!words.every(w => w.length > 0)) return; // not everyone locked yet

  const normalized = words.map(w => w.trim().toLowerCase());
  const allSame = normalized.every(w => w === normalized[0]);

  // Move lockedWord -> lastWord for bubbles
  room.players.forEach((p, i) => {
    p.lastWord = words[i];
    p.lockedWord = null;
  });

  if (allSame) {
    room.status = "finished";
    broadcast(room, {
      type: "round_result",
      match: true,
      word: words[0],
      room: serializeRoom(room)
    });
  } else {
    room.round += 1;
    broadcast(room, {
      type: "round_result",
      match: false,
      words: room.players.map((p) => ({
        id: p.id,
        word: p.lastWord || ""
      })),
      room: serializeRoom(room)
    });
  }
}

// ---------------------- WEBSOCKET EVENTS ----------------------

wss.on("connection", (ws) => {
  const client = {
    id: nextClientId++,
    name: null,
    roomCode: null,
    ws
  };
  clients.set(ws, client);

  send(ws, { type: "welcome", clientId: client.id });

  ws.on("message", (buffer) => {
    let msg;
    try {
      msg = JSON.parse(buffer.toString());
    } catch {
      return;
    }

    const type = msg.type;

    // ---- set_name ----
    if (type === "set_name") {
      const name = (msg.name || "").trim().slice(0, 24);
      if (!name) return;
      client.name = name;

      const room = getRoomFor(client);
      if (room) {
        const p = room.players.find(x => x.id === client.id);
        if (p) p.name = client.name;
        broadcastRoomUpdate(room);
      }
      return;
    }

    // ---- create_room ----
    if (type === "create_room") {
      const count = Number(msg.playerCount) || 2;
      if (count < 2 || count > 4) {
        return send(ws, { type: "error", message: "Player count must be 2–4." });
      }
      if (client.roomCode) {
        return send(ws, { type: "error", message: "You are already in a room." });
      }

      const code = generateRoomCode();
      const room = {
        code,
        hostId: client.id,
        status: "lobby",
        round: 1,
        targetPlayers: count,
        players: []
      };
      rooms.set(code, room);

      addClientToRoom(client, room);

      send(ws, {
        type: "room_created",
        room: serializeRoom(room),
        roomCode: code,
        youId: client.id
      });
      return;
    }

    // ---- join_room ----
    if (type === "join_room") {
      const code = (msg.roomCode || "").trim().toUpperCase();
      if (!rooms.has(code)) {
        return send(ws, { type: "error", message: "Room not found." });
      }
      const room = rooms.get(code);

      if (client.roomCode && client.roomCode !== code) {
        return send(ws, { type: "error", message: "You are already in another room." });
      }
      if (room.players.length >= (room.targetPlayers || 4)) {
        return send(ws, { type: "error", message: "Room is full." });
      }

      addClientToRoom(client, room);

      send(ws, {
        type: "joined_room",
        room: serializeRoom(room),
        roomCode: code,
        youId: client.id
      });
      return;
    }

    // ---- start_game ----
    if (type === "start_game") {
      const room = getRoomFor(client);
      if (!room) return;

      if (room.hostId !== client.id) {
        return send(ws, { type: "error", message: "Only the host can start the game." });
      }
      if (room.status !== "lobby") return;
      if (room.players.length < 2) {
        return send(ws, { type: "error", message: "Need at least 2 players to start." });
      }

      room.status = "playing";
      room.round = 1;
      room.players.forEach((p) => {
        p.lockedWord = null;
        p.lastWord   = null;
      });

      broadcast(room, {
        type: "start_next_round",
        room: serializeRoom(room)
      });
      return;
    }

    // ---- lock_word ----
    if (type === "lock_word") {
      const room = getRoomFor(client);
      if (!room || room.status !== "playing") return;

      const value = (msg.word || "").trim();
      if (!value) return;

      const p = room.players.find(x => x.id === client.id);
      if (!p) return;

      p.lockedWord = value.slice(0, 32);

      const allLocked = room.players.every(x => x.lockedWord && x.lockedWord.length > 0);
      if (allLocked) {
        resolveRound(room);
      } else {
        broadcastRoomUpdate(room);
      }
      return;
    }

    // ---- play_again (NEW GAME) ----
    if (type === "play_again") {
      const room = getRoomFor(client);
      if (!room) return;

      if (room.hostId !== client.id) {
        return send(ws, { type: "error", message: "Only the host can start a new game." });
      }

      // Treat play_again as "new game" – reset to round 1, clear lastWord
      room.status = "playing";
      room.round  = 1;
      room.players.forEach((p) => {
        p.lockedWord = null;
        p.lastWord   = null;
      });

      broadcast(room, {
        type: "start_next_round",
        room: serializeRoom(room)
      });
      return;
    }

    // ---- leave_room ----
    if (type === "leave_room") {
      removeClientFromRoom(client);
      send(ws, { type: "left_room" });
      return;
    }
  });

  ws.on("close", () => {
    const c = clients.get(ws);
    if (c) removeClientFromRoom(c);
    clients.delete(ws);
  });
});

// ---------------------- START SERVER --------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wordynx server running on http://localhost:${PORT}`);
});