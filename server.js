const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const WIN = 5;            // số quân liền để thắng
const LIMIT = 100000;     // giới hạn toạ độ để tránh gửi nước đi phi lý
const GRACE_MS = 30000;   // thời gian giữ ghế khi người chơi mất kết nối
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const rooms = new Map();

app.use(express.static("public"));

const key = (r, c) => r + "," + c;

function newRoom() {
  return {
    cells: {},            // { "r,c": "X" | "O" } chỉ lưu ô đã có quân
    turn: "X",
    first: "X",
    winner: null,
    winLine: [],
    seats: { X: null, O: null },  // { token, name, socketId, timer } hoặc null
    wins: { X: 0, O: 0 },
    last: null,
  };
}

// Trả về danh sách ô tạo thành 5 quân liền có chứa (r, c), hoặc null
function lineThrough(cells, r, c, v) {
  for (const [dr, dc] of DIRS) {
    const line = [[r, c]];
    for (const s of [1, -1]) {
      for (let k = 1; ; k++) {
        const rr = r + dr * k * s, cc = c + dc * k * s;
        if (cells[key(rr, cc)] !== v) break;
        line.push([rr, cc]);
      }
    }
    if (line.length >= WIN) return line;
  }
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
    cells: r.cells,
    turn: r.turn,
    winner: r.winner,
    winLine: r.winLine,
    last: r.last,
    seatStatus: { X: seatStatus(r, "X"), O: seatStatus(r, "O") },
    names: { X: r.seats.X ? r.seats.X.name : null, O: r.seats.O ? r.seats.O.name : null },
    wins: r.wins,
    title: r.title,
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
  const gone = r.seats[s];
  r.seats[s] = null;
  io.to(id).emit("notice", { text: `${gone.name} đã rời phòng.` });

  const sockets = await io.in(id).fetchSockets();
  const takenTokens = Object.values(r.seats).filter(Boolean).map(x => x.token);
  const candidate = sockets.find(
    x => !x.data.seat && x.data.room === id && !takenTokens.includes(x.data.token)
  );
  if (candidate) {
    r.seats[s] = { token: candidate.data.token, name: candidate.data.name, socketId: candidate.id, timer: null };
    candidate.data.seat = s;
    io.to(id).emit("notice", { text: `${candidate.data.name} đã vào ghế ${s}.` });
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
    io.to(id).emit("notice", { text: `${seatObj.name} đã mất kết nối. Ván tạm dừng, giữ ghế ${s} trong 30 giây.` });
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
  socket.data = { room: null, seat: null, token: null, name: null };

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

    // 1. Nếu mã này đã từng giữ ghế, trả lại đúng ghế đó
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
      io.to(id).emit("notice", { text: `${name} đã quay lại ghế ${seat}.` });
    } else {
      // 2. Nếu còn ghế trống thì nhận ghế
      for (const s of ["X", "O"]) {
        if (!r.seats[s]) {
          seat = s;
          r.seats[s] = { token, name, socketId: socket.id, timer: null };
          io.to(id).emit("notice", { text: `${name} đã vào phòng (${s}).` });
          break;
        }
      }
    }

    socket.data.seat = seat;
    socket.emit("seat", seat);
    broadcast(id);
  });

  socket.on("move", payload => {
    const id = socket.data.room;
    const s = socket.data.seat;
    if (!id || !s) return;
    const r = rooms.get(id);
    if (!r || !bothActive(r)) return;
    if (!r.seats[s] || r.seats[s].socketId !== socket.id) return;

    const row = payload && payload.r, col = payload && payload.c;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    if (Math.abs(row) > LIMIT || Math.abs(col) > LIMIT) return;
    if (r.winner || r.cells[key(row, col)] || r.turn !== s) return;

    r.cells[key(row, col)] = s;
    r.last = key(row, col);
    const line = lineThrough(r.cells, row, col, s);
    if (line) {
      r.winner = s;
      r.winLine = line.map(([a, b]) => key(a, b));
      r.wins[s]++;
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

    r.cells = {};
    r.winner = null;
    r.winLine = [];
    r.last = null;
    r.first = r.first === "X" ? "O" : "X";
    r.turn = r.first;
    broadcast(id);
  });

  // Tạo mã phòng ngẫu nhiên, chưa ai vào thì chưa hiện trong danh sách
  socket.on("create", (payload, cb) => {
    if (typeof payload === "function") { cb = payload; payload = {}; }
    let id;
    do { id = Math.random().toString(36).slice(2, 8); } while (rooms.has(id));
    const room = newRoom();
    room.title = String((payload && payload.name) || "Phòng mới").trim().slice(0, 30) || "Phòng mới";
    rooms.set(id, room);
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
        title: r.title || id,
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
