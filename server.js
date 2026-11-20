const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SIZE = 19;          // bàn cờ vây 19x19
const KOMI = 6.5;         // điểm bù cho Trắng
const GRACE_MS = 30000;   // thời gian giữ ghế khi người chơi mất kết nối
const rooms = new Map();

app.use(express.static("public"));

// Seat X = Đen (đi trước), seat O = Trắng
function resetBoard(r) {
  r.board = Array(SIZE * SIZE).fill("");
  r.turn = "X";
  r.passes = 0;
  r.ko = null;
  r.over = false;
  r.result = "";
  r.winner = null;
  r.captured = { X: 0, O: 0 };
  r.last = null;
}

function newRoom() {
  const r = {
    seats: { X: null, O: null },  // { token, name, socketId, timer } hoặc null
    wins: { X: 0, O: 0 },
    title: "",
  };
  resetBoard(r);
  return r;
}

function nbrs(i) {
  const row = Math.floor(i / SIZE), col = i % SIZE, out = [];
  if (row > 0) out.push(i - SIZE);
  if (row < SIZE - 1) out.push(i + SIZE);
  if (col > 0) out.push(i - 1);
  if (col < SIZE - 1) out.push(i + 1);
  return out;
}

// Nhóm quân cùng màu nối với ô i, cùng các ô tự do của nhóm
function group(b, i) {
  const color = b[i];
  const seen = new Set([i]);
  const libs = new Set();
  const stack = [i];
  while (stack.length) {
    const p = stack.pop();
    for (const n of nbrs(p)) {
      if (b[n] === "") libs.add(n);
      else if (b[n] === color && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return { stones: [...seen], libs };
}

// Đặt quân. Trả về false nếu nước đi không hợp lệ.
function tryPlay(r, i, s) {
  if (r.over || i < 0 || i >= SIZE * SIZE) return false;
  if (r.board[i] !== "" || r.turn !== s || i === r.ko) return false;

  const b = r.board.slice();
  b[i] = s;
  const opp = s === "X" ? "O" : "X";

  // Ăn các nhóm đối phương hết ô tự do
  const captured = [];
  for (const n of nbrs(i)) {
    if (b[n] === opp) {
      const g = group(b, n);
      if (g.libs.size === 0) captured.push(...g.stones);
    }
  }
  for (const p of captured) b[p] = "";

  // Cấm tự sát: nhóm vừa đặt phải còn ít nhất một ô tự do
  const own = group(b, i);
  if (own.libs.size === 0) return false;

  // Luật ko: ăn đúng một quân và nước đi chỉ là nhóm một quân có một ô tự do
  r.ko = captured.length === 1 && own.stones.length === 1 && own.libs.size === 1 ? captured[0] : null;

  r.board = b;
  r.captured[s] += captured.length;
  r.last = i;
  r.passes = 0;
  r.turn = opp;
  return true;
}

// Tính diện tích: quân trên bàn cộng vùng trống chỉ giáp một màu
function areaScore(b) {
  const area = { X: 0, O: 0 };
  for (let i = 0; i < b.length; i++) {
    if (b[i] === "X") area.X++;
    else if (b[i] === "O") area.O++;
  }
  const seen = new Set();
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== "" || seen.has(i)) continue;
    const region = [i];
    const borders = new Set();
    seen.add(i);
    const stack = [i];
    while (stack.length) {
      const p = stack.pop();
      for (const n of nbrs(p)) {
        if (b[n] === "") {
          if (!seen.has(n)) {
            seen.add(n);
            region.push(n);
            stack.push(n);
          }
        } else {
          borders.add(b[n]);
        }
      }
    }
    if (borders.size === 1) area[[...borders][0]] += region.length;
  }
  return area;
}

function endGame(id, r) {
  r.over = true;
  r.last = null;
  const area = areaScore(r.board);
  const white = area.O + KOMI;
  r.winner = area.X > white ? "X" : "O";
  r.wins[r.winner]++;
  r.result = `Đen ${area.X} - Trắng ${white} (đã cộng komi ${KOMI}). ${r.winner === "X" ? "Đen" : "Trắng"} thắng.`;
  broadcast(id);
}

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
    size: SIZE,
    board: r.board,
    turn: r.turn,
    over: r.over,
    result: r.result,
    winner: r.winner,
    passes: r.passes,
    ko: r.ko,
    captured: r.captured,
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
    io.to(id).emit("notice", { text: `${candidate.data.name} đã vào ghế ${s === "X" ? "Đen" : "Trắng"}.` });
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
    io.to(id).emit("notice", { text: `${seatObj.name} đã mất kết nối. Ván tạm dừng, giữ ghế trong 30 giây.` });
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

    // 1. Mã này đã từng giữ ghế thì trả lại đúng ghế đó
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
      io.to(id).emit("notice", { text: `${name} đã quay lại ghế ${seat === "X" ? "Đen" : "Trắng"}.` });
    } else {
      // 2. Còn ghế trống thì nhận ghế
      for (const s of ["X", "O"]) {
        if (!r.seats[s]) {
          seat = s;
          r.seats[s] = { token, name, socketId: socket.id, timer: null };
          io.to(id).emit("notice", { text: `${name} đã vào phòng (${s === "X" ? "Đen" : "Trắng"}).` });
          break;
        }
      }
    }

    socket.data.seat = seat;
    socket.emit("seat", seat);
    broadcast(id);
  });

  function activeSeat() {
    const id = socket.data.room;
    const s = socket.data.seat;
    if (!id || !s) return null;
    const r = rooms.get(id);
    if (!r || !bothActive(r) || !r.seats[s] || r.seats[s].socketId !== socket.id) return null;
    return { id, s, r };
  }

  socket.on("move", payload => {
    const a = activeSeat();
    if (!a) return;
    const row = payload && payload.r, col = payload && payload.c;
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return;
    if (tryPlay(a.r, row * SIZE + col, a.s)) broadcast(a.id);
  });

  socket.on("pass", () => {
    const a = activeSeat();
    if (!a || a.r.over || a.r.turn !== a.s) return;
    a.r.passes++;
    a.r.ko = null;
    a.r.last = null;
    a.r.turn = a.s === "X" ? "O" : "X";
    if (a.r.passes >= 2) endGame(a.id, a.r);
    else broadcast(a.id);
  });

  // Ván mới: xoá bàn, giữ tỉ số
  socket.on("rematch", () => {
    const a = activeSeat();
    if (!a) return;
    resetBoard(a.r);
    broadcast(a.id);
  });

  // Tạo phòng với tên người dùng đặt
  socket.on("create", (payload, cb) => {
    if (typeof payload === "function") { cb = payload; payload = {}; }
    let id;
    do { id = Math.random().toString(36).slice(2, 8); } while (rooms.has(id));
    const room = newRoom();
    room.title = String((payload && payload.name) || "Phòng mới").trim().slice(0, 30) || "Phòng mới";
    rooms.set(id, room);
    if (typeof cb === "function") cb(id);
  });

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
  console.log("Cờ vây chạy tại cổng " + PORT);
});
