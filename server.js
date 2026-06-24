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

// CHỈ CÒN LƯU DATA CỜ VUA
const chessRooms = {}; 

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
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🚀 Server Sảnh (Express) chạy tại: http://localhost:${PORT}`));