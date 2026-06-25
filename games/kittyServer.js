/**
 * kittyServer.js — Socket.io handler cho Mèo Nổ (Exploding Kittens)
 *
 * CÁCH DÙNG: trong server.js, thêm:
 *   const { registerKitty } = require('./games/kittyServer');
 *   registerKitty(io);
 *
 * Và thêm route:
 *   app.get('/kitty', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kitty', 'index.html')));
 */

'use strict';

const {
    createGame, playCard, drawCard, insertBomb,
    playNope, respondFavor, chooseTarget, chooseStolenCard,
    botDecide, currentPlayer, aliveList, getPlayerView,
} = require('./kittyLogic');

// ─── Room Storage ─────────────────────────────────────────────────────────────

const kittyRooms = {};
// { roomId: {
//     state: GameState | null,
//     players: { socketId: { name, ready } },
//     botCount: number,
//     nopeTimers: { [actionId]: timeoutHandle },
//     botTimer: timeoutHandle | null,
// }}

let nopeActionId = 0;

// ─── Utilities ────────────────────────────────────────────────────────────────

function getRoomIds(room) {
    return Object.keys(room.players);
}

function broadcastState(io, roomId) {
    const room = kittyRooms[roomId];
    if (!room?.state) return;
    const G = room.state;

    // Gửi view riêng cho từng socket người thật
    getRoomIds(room).forEach(socketId => {
        const view = getPlayerView(G, socketId);
        io.to(socketId).emit('kitty:state', view);
    });
}

function emitLog(io, roomId, msg) {
    io.to(`kitty:${roomId}`).emit('kitty:log', msg);
}

function handleResult(io, roomId, result, sourceSocketId = null) {
    const room = kittyRooms[roomId];
    if (!result.ok) {
        if (sourceSocketId) io.to(sourceSocketId).emit('kitty:error', result.error);
        return;
    }
    broadcastState(io, roomId);
    io.to(`kitty:${roomId}`).emit('kitty:event', { type: result.type, ...result });

    if (result.type === 'game_over') {
        const G = room.state;
        io.to(`kitty:${roomId}`).emit('kitty:game_over', {
            winner: result.winner,
            winnerName: G.playerNames[result.winner],
        });
    }

    // Lên lịch bot nếu đang là lượt bot
    scheduleBotIfNeeded(io, roomId);
}

// ─── Bot Scheduling ───────────────────────────────────────────────────────────

function scheduleBotIfNeeded(io, roomId) {
    const room = kittyRooms[roomId];
    if (!room?.state || room.state.phase !== 'playing') return;

    const G = room.state;
    const cp = currentPlayer(G);

    // Nếu đang chờ và người đang waitingFor là bot
    if (G.waitingFor) {
        const wfPlayer = G.waitingFor.player || G.waitingFor.target;
        if (wfPlayer && G.botIndexes.includes(G.playerIds.indexOf(wfPlayer))) {
            scheduleBot(io, roomId, wfPlayer, 800);
        }
        return;
    }

    const cpIndex = G.playerIds.indexOf(cp);
    if (!G.botIndexes.includes(cpIndex)) return;

    scheduleBot(io, roomId, cp, 1200);
}

function scheduleBot(io, roomId, botId, delay) {
    const room = kittyRooms[roomId];
    if (room.botTimer) clearTimeout(room.botTimer);
    room.botTimer = setTimeout(() => {
        runBot(io, roomId, botId);
    }, delay);
}

function runBot(io, roomId, botId) {
    const room = kittyRooms[roomId];
    if (!room?.state) return;
    const G = room.state;

    const decision = botDecide(G, botId);

    let result;
    switch (decision.action) {
        case 'play':
            result = playCard(G, botId, decision.cardIndex);
            break;
        case 'draw':
            result = drawCard(G, botId);
            break;
        case 'respond_favor':
            result = respondFavor(G, botId, decision.cardIndex);
            break;
        case 'choose_target':
            result = chooseTarget(G, botId, decision.targetId);
            break;
        case 'choose_stolen_card':
            result = chooseStolenCard(G, botId, decision.cardIndex);
            break;
        case 'insert_bomb':
            result = insertBomb(G, botId, decision.position);
            break;
        default:
            return;
    }

    handleResult(io, roomId, result);
}

// ─── Register Handler ─────────────────────────────────────────────────────────

function registerKitty(io) {

    io.on('connection', (socket) => {

        // ── Vào phòng / tạo phòng ─────────────────────────────────────────────

        socket.on('kitty:join', ({ roomId, name, botCount = 0 }) => {
            if (!roomId || !name) return;
            socket.join(`kitty:${roomId}`);
            socket.kittyRoom = roomId;
            socket.kittyName = name;

            if (!kittyRooms[roomId]) {
                kittyRooms[roomId] = { state: null, players: {}, botCount: 0, botTimer: null };
            }
            const room = kittyRooms[roomId];
            room.players[socket.id] = { name, ready: false };
            room.botCount = botCount;

            // Thông báo cho phòng
            io.to(`kitty:${roomId}`).emit('kitty:lobby', {
                players: Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, ready: p.ready })),
                botCount: room.botCount,
            });

            console.log(`[Kitty] ${name} vào phòng ${roomId} (bots: ${botCount})`);
        });

        // ── Ready ─────────────────────────────────────────────────────────────

        socket.on('kitty:ready', () => {
            const roomId = socket.kittyRoom;
            if (!roomId || !kittyRooms[roomId]) return;
            const room = kittyRooms[roomId];
            if (room.players[socket.id]) room.players[socket.id].ready = true;

            io.to(`kitty:${roomId}`).emit('kitty:lobby', {
                players: Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, ready: p.ready })),
                botCount: room.botCount,
            });

            const realPlayers = Object.keys(room.players);
            const allReady = realPlayers.every(id => room.players[id].ready);
            const totalPlayers = realPlayers.length + (room.botCount || 0);

            if (allReady && totalPlayers >= 2 && !room.state) {
                startGame(io, roomId);
            }
        });

        // ── Rút bài ───────────────────────────────────────────────────────────

        socket.on('kitty:draw', () => {
            const roomId = socket.kittyRoom;
            const room = kittyRooms[roomId];
            if (!room?.state) return;
            const result = drawCard(room.state, socket.id);
            handleResult(io, roomId, result, socket.id);
        });

        // ── Đánh lá ───────────────────────────────────────────────────────────

        socket.on('kitty:play', ({ cardIndex }) => {
            const roomId = socket.kittyRoom;
            const room = kittyRooms[roomId];
            if (!room?.state) return;
            const result = playCard(room.state, socket.id, cardIndex);
            handleResult(io, roomId, result, socket.id);
        });

        // ── Nope ──────────────────────────────────────────────────────────────

        socket.on('kitty:nope', () => {
            const roomId = socket.kittyRoom;
            const room = kittyRooms[roomId];
            if (!room?.state) return;
            const result = playNope(room.state, socket.id);
            handleResult(io, roomId, result, socket.id);
        });

        // ── Nhét bom ─────────────────────────────────────────────────────────

        socket.on('kitty:insert_bomb', ({ position }) => {
            const roomId = socket.kittyRoom;
            const room = kittyRooms[roomId];
            if (!room?.state) return;
            const result = insertBomb(room.state, socket.id, position);
            handleResult(io, roomId, result, socket.id);
        });

        // ── Chọn mục tiêu (Favor / Cat) ───────────────────────────────────────

        socket.on('kitty:choose_target', ({ targetId }) => {
            const roomId = socket.kittyRoom;
            const room = kittyRooms[roomId];
            if (!room?.state) return;
            const result = chooseTarget(room.state, socket.id, targetId);
            handleResult(io, roomId, result, socket.id);
        });

        // ── Tự chọn vị trí lá (mù) để bốc khi ăn trộm bằng cặp Cat ─────────────

        socket.on('kitty:choose_stolen_card', ({ cardIndex }) => {
            const roomId = socket.kittyRoom;
            const room = kittyRooms[roomId];
            if (!room?.state) return;
            const result = chooseStolenCard(room.state, socket.id, cardIndex);
            handleResult(io, roomId, result, socket.id);
        });

        // ── Trả lời Favor ─────────────────────────────────────────────────────

        socket.on('kitty:favor_give', ({ cardIndex }) => {
            const roomId = socket.kittyRoom;
            const room = kittyRooms[roomId];
            if (!room?.state) return;
            const result = respondFavor(room.state, socket.id, cardIndex);
            handleResult(io, roomId, result, socket.id);
        });

        // ── Chơi lại ─────────────────────────────────────────────────────────

        socket.on('kitty:rematch', () => {
            const roomId = socket.kittyRoom;
            const room = kittyRooms[roomId];
            if (!room) return;
            // Reset ready
            Object.keys(room.players).forEach(id => { room.players[id].ready = false; });
            room.state = null;
            io.to(`kitty:${roomId}`).emit('kitty:lobby', {
                players: Object.entries(room.players).map(([id, p]) => ({ id, name: p.name, ready: p.ready })),
                botCount: room.botCount,
            });
        });

        // ── Disconnect ───────────────────────────────────────────────────────

        socket.on('disconnect', () => {
            const roomId = socket.kittyRoom;
            if (!roomId || !kittyRooms[roomId]) return;
            const room = kittyRooms[roomId];
            delete room.players[socket.id];

            io.to(`kitty:${roomId}`).emit('kitty:player_left', {
                name: socket.kittyName,
                playersLeft: Object.keys(room.players).length,
            });

            if (Object.keys(room.players).length === 0) {
                if (room.botTimer) clearTimeout(room.botTimer);
                delete kittyRooms[roomId];
            }
        });
    });
}

// ─── Start Game ───────────────────────────────────────────────────────────────

function startGame(io, roomId) {
    const room = kittyRooms[roomId];
    const realSocketIds = Object.keys(room.players);
    const realNames = {};
    realSocketIds.forEach(id => { realNames[id] = room.players[id].name; });

    // Tạo bot ids giả
    const botIds = [];
    const botNames = {};
    const botCount = room.botCount || 0;
    for (let i = 0; i < botCount; i++) {
        const botId = `bot_${roomId}_${i}`;
        botIds.push(botId);
        botNames[botId] = `🤖 Bot ${i + 1}`;
    }

    const allIds = [...realSocketIds, ...botIds];
    const allNames = { ...realNames, ...botNames };

    // Xác định vị trí bot
    const botIndexes = botIds.map(id => allIds.indexOf(id));

    try {
        room.state = createGame(allIds, allNames, botIndexes);
        io.to(`kitty:${roomId}`).emit('kitty:game_start', {
            playerIds: allIds,
            playerNames: allNames,
            botIds,
        });
        broadcastState(io, roomId);
        scheduleBotIfNeeded(io, roomId);
        console.log(`[Kitty] Game started in room ${roomId} — ${allIds.length} players`);
    } catch (e) {
        io.to(`kitty:${roomId}`).emit('kitty:error', e.message);
    }
}

module.exports = { registerKitty };