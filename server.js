const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const N = 50;          // kích thước bàn
const WIN = 5;         // số quân liền để thắng
const SIZE = N * N;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const rooms = new Map();

app.use(express.static("public"));

function newRoom() {
  return {
    board: Array(SIZE).fill(""),
    turn: "X",
    first: "X",
    winner: null,
    winLine: [],
    players: { X: null, O: null },
    wins: { X: 0, O: 0 },
    draws: 0,
    last: -1,
  };
}

function check(b) {
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = b[r * N + c];
      if (!v) continue;
      for (const [dr, dc] of DIRS) {
        const line = [];
        for (let k = 0; k < WIN; k++) {
          const rr = r + dr * k, cc = c + dc * k;
          if (rr < 0 || rr >= N || cc < 0 || cc >= N || b[rr * N + cc] !== v) break;
          line.push(rr * N + cc);
        }
        if (line.length === WIN) return { w: v, line };
      }
    }
  }
  if (b.every(x => x)) return { w: "draw", line: [] };
  return null;
}

// Chỉ gửi những gì client cần, không gửi socket id của người chơi
function publicState(r) {
  return {
    board: r.board,
    turn: r.turn,
    winner: r.winner,
    winLine: r.winLine,
    seats: { X: !!r.players.X, O: !!r.players.O },
    wins: r.wins,
    draws: r.draws,
    last: r.last,
  };
}

io.on("connection", socket => {
  let roomId = null;
  let seat = null;

  socket.on("join", name => {
    const id = String(name || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    if (!id) return;

    if (roomId) {
      socket.leave(roomId);
      releaseSeat();
    }

    roomId = id;
    socket.join(id);
    if (!rooms.has(id)) rooms.set(id, newRoom());
    const r = rooms.get(id);

    seat = !r.players.X ? "X" : (!r.players.O ? "O" : null);
    if (seat) r.players[seat] = socket.id;

    socket.emit("seat", seat);
    io.to(id).emit("state", publicState(r));
  });

  socket.on("move", i => {
    if (!roomId || !seat) return;
    const r = rooms.get(roomId);
    if (!r) return;
    if (!Number.isInteger(i) || i < 0 || i >= SIZE) return;
    if (r.players[seat] !== socket.id) return;
    if (r.winner || r.board[i] || r.turn !== seat) return;

    r.board[i] = seat;
    r.last = i;
    const res = check(r.board);
    if (res) {
      r.winner = res.w;
      r.winLine = res.line;
      if (res.w === "draw") r.draws++;
      else r.wins[res.w]++;
    } else {
      r.turn = seat === "X" ? "O" : "X";
    }
    io.to(roomId).emit("state", publicState(r));
  });

  socket.on("rematch", () => {
    if (!roomId || !seat) return;
    const r = rooms.get(roomId);
    if (!r || !r.winner || r.players[seat] !== socket.id) return;

    r.board = Array(SIZE).fill("");
    r.winner = null;
    r.winLine = [];
    r.last = -1;
    r.first = r.first === "X" ? "O" : "X";
    r.turn = r.first;
    io.to(roomId).emit("state", publicState(r));
  });

  socket.on("disconnect", () => {
    if (!roomId) return;
    releaseSeat();
  });

  function releaseSeat() {
    const r = rooms.get(roomId);
    if (r && seat && r.players[seat] === socket.id) {
      r.players[seat] = null;
      io.to(roomId).emit("state", publicState(r));
    }
    seat = null;
    // Xoá phòng khi không còn ai
    setTimeout(() => {
      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room || room.size === 0) rooms.delete(roomId);
    }, 5000);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Caro chạy tại cổng " + PORT);
});
