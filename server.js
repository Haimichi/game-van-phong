const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Cấp quyền đọc thư mục games
app.use('/games', express.static(path.join(__dirname, 'games')));
app.use(express.static('public'));

app.get('/uno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'uno', 'index.html')));
app.get('/chess', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chess', 'index.html')));
app.get('/minesweeper', (req, res) => res.sendFile(path.join(__dirname, 'public', 'minesweeper', 'index.html')));
app.get('/jenga', (req, res) => res.sendFile(path.join(__dirname, 'public', 'jenga', 'index.html')));

// CHỈ CÒN LƯU DATA CỜ VUA
const chessRooms = {}; 

// ==========================================
// LOGIC DÒ MÌN (MINESWEEPER) — Race to clear, bàn mìn chung
// ==========================================
const minesRooms = {}; // { roomId: { diff, rows, cols, mines: Set("r-c"), players: { socketId: {name, avatar, status} }, finished } }

const MINES_DIFF = {
    easy:   { rows: 9,  cols: 9,  mines: 10 },
    medium: { rows: 16, cols: 16, mines: 40 },
    hard:   { rows: 16, cols: 30, mines: 99 }
};

function generateMineSet(rows, cols, mineCount) {
    const total = rows * cols;
    const positions = new Set();
    while (positions.size < Math.min(mineCount, total)) {
        positions.add(Math.floor(Math.random() * total));
    }
    // Lưu dạng "r-c" cho dễ tra cứu
    const mineSet = new Set();
    positions.forEach(idx => {
        const r = Math.floor(idx / cols);
        const c = idx % cols;
        mineSet.add(`${r}-${c}`);
    });
    return mineSet;
}

function countAdjacentMines(r, c, rows, cols, mineSet) {
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && mineSet.has(`${nr}-${nc}`)) count++;
        }
    }
    return count;
}

// Mở rộng tự động (flood-fill) các ô số 0, trả về danh sách { r, c, value } đã mở
function floodReveal(startR, startC, rows, cols, mineSet) {
    const opened = [];
    const visited = new Set();
    const stack = [[startR, startC]];
    while (stack.length) {
        const [r, c] = stack.pop();
        const key = `${r}-${c}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        if (mineSet.has(key)) continue;
        const value = countAdjacentMines(r, c, rows, cols, mineSet);
        opened.push({ r, c, value });
        if (value === 0) {
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    stack.push([r + dr, c + dc]);
                }
            }
        }
    }
    return opened;
}

// ==========================================
// CHAT SYSTEM (per room)
// ==========================================
const roomChats = {}; // { roomId: [{ playerID, name, text, timestamp }, ...] }
const roomPlayers = {}; // { roomId: { playerID: playerName } } — danh sách tên người chơi đang biết trong phòng

io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // ==========================================
    // CHAT EVENTS
    // ==========================================
    socket.on('chat:join-room', (data) => {
        const { roomId, playerID, playerName } = data;
        socket.join(`chat:${roomId}`);
        socket.playerName = playerName;
        socket.playerID = playerID;
        socket.roomId = roomId;

        // Khởi tạo chat history nếu chưa có
        if (!roomChats[roomId]) {
            roomChats[roomId] = [];
        }
        if (!roomPlayers[roomId]) {
            roomPlayers[roomId] = {};
        }
        const isNewPlayer = roomPlayers[roomId][playerID] === undefined;
        roomPlayers[roomId][playerID] = playerName;

        // Gửi lịch sử chat cho player mới join
        socket.emit('chat:history', roomChats[roomId]);

        // Đồng bộ danh sách tên (playerID -> playerName) cho TẤT CẢ người trong phòng,
        // kể cả người vừa join, để ai cũng thấy đúng tên thật của nhau (không chỉ "Player 0/1/2").
        io.to(`chat:${roomId}`).emit('chat:roster', roomPlayers[roomId]);

        // Thông báo player khác rằng có người mới join (chỉ khi đây là lần đầu join, tránh spam khi reconnect)
        if (isNewPlayer) {
            const joinMsg = {
                type: 'system',
                playerID: 'system',
                playerName: 'Hệ thống',
                text: `${playerName} vừa tham gia phòng`,
                timestamp: Date.now()
            };
            roomChats[roomId].push(joinMsg);
            if (roomChats[roomId].length > 200) roomChats[roomId].shift();
            socket.to(`chat:${roomId}`).emit('chat:message', joinMsg);
        }

        console.log(`[Chat] Player ${playerID} (${playerName}) joined room ${roomId}`);
    });

    // Đổi tên hiển thị (không phát lại lịch sử / không bắn thông báo "vừa tham gia phòng")
    socket.on('chat:rename', (data) => {
        const { roomId, playerID, playerName } = data;
        if (!roomId || !playerName || !playerName.trim()) return;
        if (!roomPlayers[roomId]) roomPlayers[roomId] = {};
        const oldName = roomPlayers[roomId][playerID];
        const newName = playerName.trim();
        roomPlayers[roomId][playerID] = newName;
        socket.playerName = newName;

        io.to(`chat:${roomId}`).emit('chat:roster', roomPlayers[roomId]);

        if (oldName && oldName !== newName && roomChats[roomId]) {
            const renameMsg = {
                type: 'system',
                playerID: 'system',
                playerName: 'Hệ thống',
                text: `${oldName} đã đổi tên thành ${newName}`,
                timestamp: Date.now()
            };
            roomChats[roomId].push(renameMsg);
            if (roomChats[roomId].length > 200) roomChats[roomId].shift();
            io.to(`chat:${roomId}`).emit('chat:message', renameMsg);
        }
    });

    socket.on('chat:send', (data) => {
        const { roomId, playerID, playerName, text } = data;
        
        if (!text || !text.trim()) return;

        const message = {
            type: 'user',
            playerID,
            playerName,
            text: text.trim(),
            timestamp: Date.now()
        };

        // Lưu vào history
        if (roomChats[roomId]) {
            roomChats[roomId].push(message);
            // Giữ tối đa 200 tin nhắn
            if (roomChats[roomId].length > 200) {
                roomChats[roomId].shift();
            }
        }

        // Gửi cho tất cả player trong phòng (kể cả người gửi)
        io.to(`chat:${roomId}`).emit('chat:message', message);

        console.log(`[Chat] ${playerName}: ${text} (room: ${roomId})`);
    });

    socket.on('disconnect', () => {
        if (socket.roomId && socket.playerName) {
            io.to(`chat:${socket.roomId}`).emit('chat:message', {
                type: 'system',
                playerID: 'system',
                playerName: 'Hệ thống',
                text: `${socket.playerName} đã rời phòng`,
                timestamp: Date.now()
            });
            console.log(`[Chat] ${socket.playerName} disconnected from ${socket.roomId}`);
        }
    });

    socket.on('lobby-chat', (data) => { io.emit('lobby-chat', data); });

    // ==========================================
    // LOGIC CỜ VUA (Giữ nguyên của sếp)
    // ==========================================
    socket.on('join-room', (data) => {
        const { roomId, name, avatar } = data;
        socket.join(roomId); 
        socket.roomId = roomId;
        if (!chessRooms[roomId]) chessRooms[roomId] = { players: {} };
        chessRooms[roomId].players[socket.id] = { name, avatar, roll: null };
        const pIds = Object.keys(chessRooms[roomId].players);
        if (pIds.length === 1) socket.emit('room-status', { status: 'waiting' });
        else if (pIds.length === 2) io.to(roomId).emit('room-status', { status: 'ready-to-roll', players: chessRooms[roomId].players });
        else socket.emit('room-status', { status: 'full' });
    });
    
    socket.on('roll-dice', (roomId) => {
        const room = chessRooms[roomId];
        if (!room) return;
        const rollResult = Math.floor(Math.random() * 6) + 1;
        room.players[socket.id].roll = rollResult;
        io.to(roomId).emit('dice-result', { id: socket.id, roll: rollResult, name: room.players[socket.id].name });
        const pIds = Object.keys(room.players);
        if (pIds.length === 2 && room.players[pIds[0]].roll && room.players[pIds[1]].roll) {
            const p1 = pIds[0], p2 = pIds[1], r1 = room.players[p1].roll, r2 = room.players[p2].roll;
            setTimeout(() => {
                if (r1 === r2) {
                    room.players[p1].roll = null; room.players[p2].roll = null;
                    io.to(roomId).emit('roll-tie');
                } else {
                    const whiteId = r1 > r2 ? p1 : p2; const blackId = r1 > r2 ? p2 : p1;
                    io.to(whiteId).emit('game-start', { color: 'w', opponent: room.players[blackId] });
                    io.to(blackId).emit('game-start', { color: 'b', opponent: room.players[whiteId] });
                }
            }, 1500);
        }
    });
    socket.on('chess-move', (data) => { socket.to(data.roomId).emit('chess-move', data.move); });
    socket.on('room-chat', (data) => { io.to(data.roomId).emit('room-chat', { name: data.name, msg: data.msg, avatar: data.avatar }); });
    socket.on('chess-reset', (roomId) => { io.to(roomId).emit('chess-reset'); });
    socket.on('chess-resign', (data) => { socket.to(data.roomId).emit('opponent-resigned', data.name); });

    socket.on('disconnect', () => {
        if (socket.roomId && chessRooms[socket.roomId]) {
            delete chessRooms[socket.roomId].players[socket.id];
            socket.to(socket.roomId).emit('opponent-resigned', "Đối thủ");
            if (Object.keys(chessRooms[socket.roomId].players).length === 0) delete chessRooms[socket.roomId];
        }
    });

    // ==========================================
    // LOGIC DÒ MÌN (MINESWEEPER)
    // ==========================================
    socket.on('mines:join-room', (data) => {
        const { roomId, name, avatar, diff } = data;
        socket.join(`mines:${roomId}`);
        socket.minesRoomId = roomId;

        if (!minesRooms[roomId]) {
            const chosenDiff = MINES_DIFF[diff] ? diff : 'easy';
            const { rows, cols, mines } = MINES_DIFF[chosenDiff];
            minesRooms[roomId] = {
                diff: chosenDiff,
                rows, cols,
                mineCount: mines,
                mineSet: generateMineSet(rows, cols, mines),
                players: {},
                finished: false
            };
        }

        const room = minesRooms[roomId];
        const pIds = Object.keys(room.players);

        if (!room.players[socket.id] && pIds.length >= 2) {
            socket.emit('mines:room-full');
            return;
        }

        room.players[socket.id] = room.players[socket.id] || {
            name, avatar, opened: 0, status: 'playing' // playing | won | lost
        };

        const updatedIds = Object.keys(room.players);

        // Nếu phòng đã kết thúc trước khi đủ 2 người (VD: người tạo phòng tự dò một mình
        // trước khi đối thủ vào) thì sinh bàn mìn mới ngay khi đủ 2 người, tránh phòng "chết".
        if (room.finished && updatedIds.length === 2) {
            room.mineSet = generateMineSet(room.rows, room.cols, room.mineCount);
            room.finished = false;
            Object.values(room.players).forEach(p => { p.status = 'playing'; p.openedSet = new Set(); });
        }

        // Gửi cấu hình bàn cờ (không tiết lộ vị trí mìn) cho người vừa join
        socket.emit('mines:init', {
            rows: room.rows,
            cols: room.cols,
            mineCount: room.mineCount,
            diff: room.diff,
            players: room.players,
            youId: socket.id
        });

        io.to(`mines:${roomId}`).emit('mines:players-update', room.players);

        if (updatedIds.length === 2) {
            io.to(`mines:${roomId}`).emit('mines:start');
        } else {
            socket.emit('mines:waiting');
        }
    });

    socket.on('mines:reveal', (data) => {
        const { roomId, r, c } = data;
        const room = minesRooms[roomId];
        if (!room || room.finished) return;
        const player = room.players[socket.id];
        if (!player || player.status !== 'playing') return;

        const key = `${r}-${c}`;

        if (room.mineSet.has(key)) {
            // Đụng bom -> thua ngay
            player.status = 'lost';
            room.finished = true;
            io.to(`mines:${roomId}`).emit('mines:player-hit-mine', {
                playerId: socket.id,
                r, c,
                mines: Array.from(room.mineSet).map(k => {
                    const [mr, mc] = k.split('-').map(Number);
                    return { r: mr, c: mc };
                })
            });

            socket.emit('mines:game-result', { result: 'lose', reason: 'hit-mine' });

            const otherIds = Object.keys(room.players).filter(id => id !== socket.id);
            if (otherIds.length > 0 && room.players[otherIds[0]].status === 'playing') {
                room.players[otherIds[0]].status = 'won';
                io.to(otherIds[0]).emit('mines:game-result', { result: 'win', reason: 'opponent-hit-mine' });
            }
            return;
        }

        const opened = floodReveal(r, c, room.rows, room.cols, room.mineSet);
        player.opened = (player.openedSet = player.openedSet || new Set());
        opened.forEach(cell => player.openedSet.add(`${cell.r}-${cell.c}`));

        const totalSafeCells = room.rows * room.cols - room.mineSet.size;

        socket.emit('mines:reveal-result', { opened });
        socket.to(`mines:${roomId}`).emit('mines:opponent-progress', {
            playerId: socket.id,
            openedCount: player.openedSet.size,
            totalSafeCells
        });

        if (player.openedSet.size >= totalSafeCells && !room.finished) {
            player.status = 'won';
            room.finished = true;
            const otherIds = Object.keys(room.players).filter(id => id !== socket.id);
            socket.emit('mines:game-result', { result: 'win', reason: 'cleared-board' });
            if (otherIds.length > 0) {
                room.players[otherIds[0]].status = 'lost';
                io.to(otherIds[0]).emit('mines:game-result', { result: 'lose', reason: 'opponent-cleared-board' });
            }
        }
    });

    socket.on('mines:flag', (data) => {
        const { roomId, r, c, flagged } = data;
        socket.to(`mines:${roomId}`).emit('mines:opponent-flag', { playerId: socket.id, r, c, flagged });
    });

    socket.on('mines:rematch', (data) => {
        const { roomId, diff } = data;
        const room = minesRooms[roomId];
        if (!room) return;
        const chosenDiff = MINES_DIFF[diff] ? diff : room.diff;
        const { rows, cols, mines } = MINES_DIFF[chosenDiff];
        room.diff = chosenDiff;
        room.rows = rows; room.cols = cols; room.mineCount = mines;
        room.mineSet = generateMineSet(rows, cols, mines);
        room.finished = false;
        Object.values(room.players).forEach(p => { p.status = 'playing'; p.openedSet = new Set(); });
        io.to(`mines:${roomId}`).emit('mines:rematch-start', {
            rows: room.rows, cols: room.cols, mineCount: room.mineCount, diff: room.diff, players: room.players
        });
    });

    socket.on('mines:resign', (data) => {
        const { roomId } = data;
        const room = minesRooms[roomId];
        if (!room || room.finished) return;
        const player = room.players[socket.id];
        if (!player) return;
        player.status = 'lost';
        const otherIds = Object.keys(room.players).filter(id => id !== socket.id);
        if (otherIds.length > 0) {
            room.players[otherIds[0]].status = 'won';
            room.finished = true;
            io.to(otherIds[0]).emit('mines:game-result', { result: 'win', reason: 'opponent-resigned' });
        }
        socket.emit('mines:game-result', { result: 'lose', reason: 'resigned' });
    });

    socket.on('disconnect', () => {
        if (socket.minesRoomId && minesRooms[socket.minesRoomId]) {
            const room = minesRooms[socket.minesRoomId];
            delete room.players[socket.id];
            socket.to(`mines:${socket.minesRoomId}`).emit('mines:opponent-left');
            if (Object.keys(room.players).length === 0) delete minesRooms[socket.minesRoomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🚀 Server Sảnh (Express) chạy tại: http://localhost:${PORT}`));