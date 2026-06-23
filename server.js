const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static('public'));
app.get('/uno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'uno', 'index.html')));
app.get('/chess', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chess', 'index.html')));

// --- DATA STORE ---
const chessRooms = {}; 
const unoRooms = {}; 

function createUnoDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    const deck = [];
    let id = 0;
    colors.forEach(color => {
        deck.push({ id: `c_${id++}`, color: color, value: '0' });
        for (let i = 1; i <= 9; i++) {
            deck.push({ id: `c_${id++}`, color: color, value: i.toString() });
            deck.push({ id: `c_${id++}`, color: color, value: i.toString() });
        }
        ['Skip', 'Reverse', '+2'].forEach(action => {
            deck.push({ id: `c_${id++}`, color: color, value: action });
            deck.push({ id: `c_${id++}`, color: color, value: action });
        });
    });
    for (let i = 0; i < 4; i++) {
        deck.push({ id: `c_${id++}`, color: 'black', value: 'Wild' });
        deck.push({ id: `c_${id++}`, color: 'black', value: '+4' });
    }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('lobby-chat', (data) => { io.emit('lobby-chat', data); });

    // ==========================================
    // LOGIC GAME UNO (ĐÃ NÂNG CẤP HOST & BOTS)
    // ==========================================
    socket.on('join-uno', (data) => {
        const { roomId, name, avatar } = data;
        socket.join(roomId);
        socket.unoRoomId = roomId;

        if (!unoRooms[roomId]) {
            // Người đầu tiên vào sẽ làm Host
            unoRooms[roomId] = {
                host: socket.id,
                players: [],
                deck: [],
                discardPile: [],
                status: 'waiting' 
            };
        }

        const room = unoRooms[roomId];

        // TRƯỜNG HỢP 1: VÀO PHÒNG KHI GAME ĐANG CHƠI (TÌM BOT ĐỂ THẾ CHỖ)
        if (room.status === 'playing') {
            const botIndex = room.players.findIndex(p => p.isBot);
            if (botIndex !== -1) {
                // Có Bot -> Cướp quyền Bot
                const botHand = room.players[botIndex].hand;
                room.players[botIndex] = { id: socket.id, name: name, avatar: avatar, hand: botHand, isBot: false };
                
                io.to(roomId).emit('uno-update-players', { players: room.players, host: room.host });
                
                // Gửi thẳng bài cho người mới
                socket.emit('uno-game-started', {
                    hand: botHand,
                    topCard: room.discardPile[room.discardPile.length - 1],
                    playersInfo: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, cardCount: p.hand.length, isBot: p.isBot }))
                });
                return;
            } else {
                // Không có Bot -> Báo lỗi văng ra
                socket.emit('uno-error', 'Phòng đã đầy và đang trong trận!');
                return;
            }
        }

        // TRƯỜNG HỢP 2: VÀO PHÒNG CHỜ BÌNH THƯỜNG
        room.players.push({ id: socket.id, name, avatar, hand: [], isBot: false });
        io.to(roomId).emit('uno-update-players', { players: room.players, host: room.host });
    });

    socket.on('uno-start-game', (roomId) => {
        const room = unoRooms[roomId];
        // Chỉ Host mới được phép Start
        if (!room || room.host !== socket.id) return;

        // KIỂM TRA VÀ NHỒI THÊM BOT NẾU CHƯA ĐỦ 4 NGƯỜI
        let botCount = 1;
        while (room.players.length < 4) {
            room.players.push({
                id: `bot_${Math.random().toString(36).substr(2, 5)}`,
                name: `Bot Thông Minh ${botCount}`,
                avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=Bot${botCount}`,
                hand: [],
                isBot: true
            });
            botCount++;
        }

        room.status = 'playing';
        room.deck = createUnoDeck();
        room.discardPile = [];

        // Chia cho mỗi người (kể cả Bot) 7 lá
        room.players.forEach(player => {
            player.hand = room.deck.splice(0, 7);
        });

        let firstCard = room.deck.pop();
        while(firstCard.color === 'black') {
            room.deck.unshift(firstCard); 
            firstCard = room.deck.pop();
        }
        room.discardPile.push(firstCard);

        // Phát tín hiệu bắt đầu cho tất cả người thật
        room.players.forEach(player => {
            if (!player.isBot) {
                io.to(player.id).emit('uno-game-started', {
                    hand: player.hand,
                    topCard: firstCard,
                    playersInfo: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, cardCount: p.hand.length, isBot: p.isBot }))
                });
            }
        });
        
        // Cập nhật lại UI người chơi để hiện Bot
        io.to(roomId).emit('uno-update-players', { players: room.players, host: room.host });
    });

    // ==========================================
    // LOGIC CỜ VUA
    // ==========================================
    socket.on('join-room', (data) => {
        const { roomId, name, avatar } = data;
        socket.join(roomId); socket.roomId = roomId;
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
        if (socket.unoRoomId && unoRooms[socket.unoRoomId]) {
            const room = unoRooms[socket.unoRoomId];
            room.players = room.players.filter(p => p.id !== socket.id);
            
            // Nếu Chủ phòng thoát, nhường quyền Host cho người kế tiếp
            if (room.host === socket.id) {
                const nextRealPlayer = room.players.find(p => !p.isBot);
                if (nextRealPlayer) room.host = nextRealPlayer.id;
            }
            
            io.to(socket.unoRoomId).emit('uno-update-players', { players: room.players, host: room.host });
            if (room.players.length === 0 || room.players.every(p => p.isBot)) delete unoRooms[socket.unoRoomId];
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`));