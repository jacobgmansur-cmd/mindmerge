const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files (index.html, etc.) from this folder
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---- In-memory state ----

let nextClientId = 1;

const clients = new Map(); // ws -> { id, name, roomCode }
const rooms = new Map();   // code -> room

// room = {
//   code,
//   hostId,
//   targetPlayers: 2..4,
//   players: [ { id, name, client, lockedWord, lastWord } ],
//   round,
//   status: "lobby" | "playing" | "finished"
// };

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastRoom(room, payload) {
  room.players.forEach((p) => {
    send(p.client.ws, payload);
  });
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    targetPlayers: room.targetPlayers,
    round: room.round,
    status: room.status,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      locked: !!p.lockedWord,
      lastWord: p.lastWord
    }))
  };
}

function broadcastRoomUpdate(room) {
  broadcastRoom(room, {
    type: "room_update",
    room: serializeRoom(room)
  });
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function addClientToRoom(client, room) {
  const existing = room.players.find((p) => p.id === client.id);
  if (existing) return;

  const player = {
    id: client.id,
    name: client.name || `Player ${room.players.length + 1}`,
    client,
    lockedWord: null,
    lastWord: null
  };
  room.players.push(player);
  client.roomCode = room.code;

  // Room stays in "lobby" until host presses Start Game
  broadcastRoomUpdate(room);
}

function normalizeWord(w) {
  return w.trim().toLowerCase();
}

function resolveRound(room) {
  const words = room.players.map((p) => p.lockedWord);
  const normalized = words.map(normalizeWord);
  const allSame = normalized.every((w) => w === normalized[0]);

  // Move lockedWord -> lastWord and clear locks
  room.players.forEach((p) => {
    p.lastWord = p.lockedWord;
    p.lockedWord = null;
  });

  if (allSame) {
    const winningWord = words[0];
    room.status = "finished";

    broadcastRoom(room, {
      type: "round_result",
      match: true,
      word: winningWord,
      room: serializeRoom(room)
    });
  } else {
    room.round += 1;

    broadcastRoom(room, {
      type: "round_result",
      match: false,
      words: room.players.map((p, idx) => ({
        id: p.id,
        word: words[idx]
      })),
      room: serializeRoom(room)
    });
  }
}

function handleLockWord(client, word) {
  const roomCode = client.roomCode;
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);

  if (room.status !== "playing") return;

  const player = room.players.find((p) => p.id === client.id);
  if (!player) return;

  if (!word || typeof word !== "string") return;
  const clean = word.trim().slice(0, 20); // hard-limit to 20 chars
  if (!clean) return;

  player.lockedWord = clean;

  broadcastRoomUpdate(room);

  // If everyone locked, resolve round
  if (room.players.every((p) => p.lockedWord && p.lockedWord.length > 0)) {
    resolveRound(room);
  }
}

function resetRoom(room) {
  room.round = 1;
  room.status = "playing";
  room.players.forEach((p) => {
    p.lockedWord = null;
    p.lastWord = null;
  });
  broadcastRoomUpdate(room);
}

function removeClientFromRoom(client) {
  const roomCode = client.roomCode;
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);

  room.players = room.players.filter((p) => p.id !== client.id);

  if (room.players.length === 0) {
    rooms.delete(roomCode);
  } else {
    // If host left, promote first remaining player as host
    if (room.hostId === client.id) {
      room.hostId = room.players[0].id;
    }
    broadcastRoomUpdate(room);
  }

  client.roomCode = null;
}

function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client) return;

  removeClientFromRoom(client);
  clients.delete(ws);
}

// ---- WebSocket handling ----

wss.on("connection", (ws) => {
  const client = {
    id: nextClientId++,
    ws,
    name: null,
    roomCode: null
  };
  clients.set(ws, client);

  send(ws, { type: "welcome", clientId: client.id });

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }

    const type = data.type;

    if (type === "set_name") {
      client.name = (data.name || "").trim().slice(0, 24);
      if (!client.name) client.name = `Player ${client.id}`;

      if (client.roomCode && rooms.has(client.roomCode)) {
        const room = rooms.get(client.roomCode);
        const player = room.players.find((p) => p.id === client.id);
        if (player) {
          player.name = client.name;
          broadcastRoomUpdate(room);
        }
      }
    }

    if (type === "create_room") {
      const playerCount = Number(data.playerCount);
      if (![2, 3, 4].includes(playerCount)) {
        return send(ws, { type: "error", message: "Invalid player count." });
      }
      if (client.roomCode) {
        return send(ws, { type: "error", message: "You are already in a room." });
      }

      const code = generateRoomCode();
      const room = {
        code,
        hostId: client.id,
        targetPlayers: playerCount,
        players: [],
        round: 1,
        status: "lobby"
      };
      rooms.set(code, room);

      addClientToRoom(client, room);

      send(ws, {
        type: "room_created",
        room: serializeRoom(room),
        roomCode: code,
        youId: client.id
      });
    }

    if (type === "join_room") {
      const code = (data.roomCode || "").toUpperCase();
      if (!rooms.has(code)) {
        return send(ws, { type: "error", message: "Room not found." });
      }
      const room = rooms.get(code);

      if (client.roomCode && client.roomCode !== code) {
        return send(ws, { type: "error", message: "You are already in another room." });
      }

      if (room.players.length >= room.targetPlayers) {
        return send(ws, { type: "error", message: "Room is full." });
      }

      addClientToRoom(client, room);

      send(ws, {
        type: "joined_room",
        room: serializeRoom(room),
        roomCode: code,
        youId: client.id
      });
    }

    if (type === "start_game") {
      const roomCode = client.roomCode;
      if (!roomCode || !rooms.has(roomCode)) return;
      const room = rooms.get(roomCode);

      if (room.hostId !== client.id) {
        return send(ws, { type: "error", message: "Only the host can start the game." });
      }
      if (room.status !== "lobby") return;
      if (room.players.length !== room.targetPlayers) {
        return send(ws, { type: "error", message: "Wait for all players to join." });
      }

      room.status = "playing";
      room.round = 1;
      room.players.forEach((p) => {
        p.lockedWord = null;
        p.lastWord = null;
      });
      broadcastRoomUpdate(room);
    }

    if (type === "lock_word") {
      handleLockWord(client, data.word);
    }

    if (type === "play_again") {
      const roomCode = client.roomCode;
      if (!roomCode || !rooms.has(roomCode)) return;
      const room = rooms.get(roomCode);
      if (room.status !== "finished") return;
      if (room.hostId !== client.id) {
        return send(ws, { type: "error", message: "Only the host can start the next round." });
      }
      resetRoom(room);
    }

    if (type === "leave_room") {
      removeClientFromRoom(client);
      send(ws, { type: "left_room" });
    }
  });

  ws.on("close", () => {
    handleDisconnect(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MindMerge online server listening on http://localhost:${PORT}`);
});
