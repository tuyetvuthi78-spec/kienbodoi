const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const N = 50;            // kích thước bàn
const WIN = 5;           // số quân liền để thắng
const SIZE = N * N;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const GRACE_MS = 30000;  // thời gian giữ ghế khi người chơi mất kết nối
const rooms = new Map();

app.use(express.static("public"));

function newRoom() {
  return {
    board: Array(SIZE).fill(""),
    turn: "X",
    first: "X",
    winner: null,
    winLine: [],
    // seats[X] = { token, socketId, timer } hoặc null
    seats: { X: null, O: null },
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

// "empty" = chưa có ai, "active" = đang online, "away" = mất kết nối nhưng còn giữ ghế
function seatStatus(r, s) {
  const x = r.seats[s];
  if (!x) return "empty";
  return x.socketId ? "active" : "away";
}

function bothActive(r) {
  return seatStatus(r, "X") === "active" && seatStatus(r, "O") === "active";
}

function publicState(r) {
  return {
    board: r.board,
    turn: r.turn,
    winner: r.winner,
    winLine: r.winLine,
    seatStatus: { X: seatStatus(r, "X"), O: seatStatus(r, "O") },
    names: { X: r.seats.X ? r.seats.X.name : null, O: r.seats.O ? r.seats.O.name : null },
    wins: r.wins,
    draws: r.draws,
    last: r.last,
  };
}

function broadcast(id) {
  const r = rooms.get(id);
  if (r) io.to(id).emit("state", publicState(r));
}

// Người mất kết nối quá lâu thì nhả ghế, người xem đầu tiên được vào thay
async function freeSeat(id, s, seatObj) {
  const r = rooms.get(id);
  if (!r || r.seats[s] !== seatObj || seatObj.socketId) return;
  r.seats[s] = null;

  const sockets = await io.in(id).fetchSockets();
  const takenTokens = Object.values(r.seats).filter(Boolean).map(x => x.token);
  const candidate = sockets.find(
    x => !x.data.seat && x.data.room === id && !takenTokens.includes(x.data.token)
  );
  if (candidate) {
    r.seats[s] = { token: candidate.data.token, name: candidate.data.name, socketId: candidate.id, timer: null };
    candidate.data.seat = s;
    candidate.emit("seat", s);
  }
  broadcast(id);
}

function leave(socket) {
  const id = socket.data.room;
  if (!id) return;
  const r = rooms.get(id);
  const s = socket.data.seat;

  if (r && s && r.seats[s] && r.seats[s].socketId === socket.id) {
    const seatObj = r.seats[s];
    seatObj.socketId = null;
    clearTimeout(seatObj.timer);
    seatObj.timer = setTimeout(() => freeSeat(id, s, seatObj), GRACE_MS);
  }

  socket.leave(id);
  socket.data.room = null;
  socket.data.seat = null;
  broadcast(id);

  // Xoá phòng nếu không còn ai
  setTimeout(() => {
    const room = io.sockets.adapter.rooms.get(id);
    if (!room || room.size === 0) {
      const rr = rooms.get(id);
      if (rr) {
        for (const s of ["X", "O"]) if (rr.seats[s]) clearTimeout(rr.seats[s].timer);
      }
      rooms.delete(id);
    }
  }, 60000);
}

io.on("connection", socket => {
  socket.data = { room: null, seat: null, token: null };

  socket.on("join", payload => {
    const id = String((payload && payload.room) || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    const token = String((payload && payload.token) || "").slice(0, 64);
    const name = String((payload && payload.name) || "Người chơi").slice(0, 20);
    if (!id || !token) return;

    if (socket.data.room) leave(socket);

    socket.join(id);
    socket.data.room = id;
    socket.data.token = token;
    socket.data.name = name;
    if (!rooms.has(id)) rooms.set(id, newRoom());
    const r = rooms.get(id);

    let seat = null;

    // 1. Nếu mã này đã từng giữ ghế, trả lại đúng ghế đó (kể cả khi vừa tải lại trang)
    for (const s of ["X", "O"]) {
      if (r.seats[s] && r.seats[s].token === token) {
        seat = s;
        break;
      }
    }
    if (seat) {
      const seatObj = r.seats[seat];
      clearTimeout(seatObj.timer);
      seatObj.timer = null;
      seatObj.socketId = socket.id;
      seatObj.name = name;
    } else {
      // 2. Nếu còn ghế trống thì nhận ghế
      for (const s of ["X", "O"]) {
        if (!r.seats[s]) {
          seat = s;
          r.seats[s] = { token, name, socketId: socket.id, timer: null };
          break;
        }
      }
    }

    socket.data.seat = seat;
    socket.emit("seat", seat);
    broadcast(id);
  });

  socket.on("move", i => {
    const id = socket.data.room;
    const s = socket.data.seat;
    if (!id || !s) return;
    const r = rooms.get(id);
    if (!r || !bothActive(r)) return;
    if (!r.seats[s] || r.seats[s].socketId !== socket.id) return;
    if (!Number.isInteger(i) || i < 0 || i >= SIZE) return;
    if (r.winner || r.board[i] || r.turn !== s) return;

    r.board[i] = s;
    r.last = i;
    const res = check(r.board);
    if (res) {
      r.winner = res.w;
      r.winLine = res.line;
      if (res.w === "draw") r.draws++;
      else r.wins[res.w]++;
    } else {
      r.turn = s === "X" ? "O" : "X";
    }
    broadcast(id);
  });

  socket.on("rematch", () => {
    const id = socket.data.room;
    const s = socket.data.seat;
    if (!id || !s) return;
    const r = rooms.get(id);
    if (!r || !r.winner || !bothActive(r)) return;
    if (!r.seats[s] || r.seats[s].socketId !== socket.id) return;

    r.board = Array(SIZE).fill("");
    r.winner = null;
    r.winLine = [];
    r.last = -1;
    r.first = r.first === "X" ? "O" : "X";
    r.turn = r.first;
    broadcast(id);
  });

  // Tạo mã phòng ngẫu nhiên, chưa ai vào thì chưa hiện trong danh sách
  socket.on("create", cb => {
    let id;
    do { id = Math.random().toString(36).slice(2, 8); } while (rooms.has(id));
    rooms.set(id, newRoom());
    if (typeof cb === "function") cb(id);
  });

  // Danh sách các phòng đang có người
  socket.on("list", cb => {
    if (typeof cb !== "function") return;
    const out = [];
    for (const [id, r] of rooms) {
      const viewers = io.sockets.adapter.rooms.get(id)?.size || 0;
      if (viewers === 0) continue;
      out.push({
        id,
        viewers,
        players: (r.seats.X ? 1 : 0) + (r.seats.O ? 1 : 0),
        names: { X: r.seats.X ? r.seats.X.name : null, O: r.seats.O ? r.seats.O.name : null },
      });
    }
    cb(out);
  });

  socket.on("disconnect", () => leave(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Caro chạy tại cổng " + PORT);
});
