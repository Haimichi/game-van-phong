/**
 * kittyLogic.js — Exploding Kittens (Mèo Nổ) Game Logic
 * Dùng với Socket.io (server.js), không phụ thuộc boardgame.io
 *
 * Các lá bài:
 *   ExplodingKitten  — Mèo Nổ (bom)
 *   Defuse           — Giải bom
 *   Skip             — Bỏ lượt
 *   Attack           — Tấn công: kết thúc lượt mình, người kế tiếp đi 2 lượt
 *   Favor            — Xin bài: bắt người khác đưa 1 lá tuỳ ý
 *   Shuffle          — Xáo bài
 *   SeeTheFuture     — Xem 3 lá trên đỉnh deck
 *   Nope             — Phủ nhận hành động người khác (đánh chen giữa lượt)
 *   Cat_*            — Cat Cards (5 loại): ghép cặp 2 lá cùng loại để ăn trộm 1 lá ngẫu nhiên
 */

'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function randInt(max) { return Math.floor(Math.random() * max); }

const CAT_TYPES = ['Cat_TacoCat', 'Cat_Beard', 'Cat_Rainbow', 'Cat_Potato', 'Cat_Cattermelon'];

function isCat(card) { return card && card.value.startsWith('Cat_'); }

// ─── Build Deck ───────────────────────────────────────────────────────────────

/**
 * Tạo deck đã xáo (không gồm ExplodingKitten & Defuse — thêm sau)
 */
function buildBaseDeck() {
    const deck = [];
    const add = (value, count) => { for (let i = 0; i < count; i++) deck.push({ value }); };

    add('Skip', 4);
    add('Attack', 4);
    add('Favor', 4);
    add('Shuffle', 4);
    add('SeeTheFuture', 5);
    add('Nope', 5);
    // Cat cards — mỗi loại 4 lá (cần >= 2 lá cùng loại để ghép cặp)
    CAT_TYPES.forEach(cat => add(cat, 4));

    return shuffle(deck);
}

// ─── Game State ───────────────────────────────────────────────────────────────

/**
 * Tạo state mới cho 1 phòng.
 * @param {string[]} playerIds   mảng socket id theo thứ tự vào phòng
 * @param {Object}   playerNames { socketId: displayName }
 * @param {boolean}  hasBots     true nếu có bot
 * @param {number[]} botIndexes  vị trí (index) là bot trong playerIds
 */
function createGame(playerIds, playerNames, botIndexes = []) {
    const n = playerIds.length;
    if (n < 2 || n > 5) throw new Error('Số người chơi phải từ 2–5');

    let deck = buildBaseDeck();

    // Chia bài: mỗi người 1 Defuse + 7 lá ngẫu nhiên
    const hands = {};
    playerIds.forEach(id => {
        hands[id] = [{ value: 'Defuse' }];
        hands[id].push(...deck.splice(0, 7));
    });

    // Thêm Defuse thừa vào deck (n-1 người đã có, thêm tối đa 2 lá Defuse nữa)
    const extraDefuse = Math.min(2, 6 - n);
    for (let i = 0; i < extraDefuse; i++) deck.push({ value: 'Defuse' });

    // Nhồi bom (numPlayers - 1)
    for (let i = 0; i < n - 1; i++) deck.push({ value: 'ExplodingKitten' });

    shuffle(deck);

    return {
        playerIds: [...playerIds],          // thứ tự turn
        playerNames: { ...playerNames },
        botIndexes: [...botIndexes],
        alive: new Set(playerIds),          // người còn sống
        hands,
        deck,
        discardPile: [],
        currentTurnIndex: 0,                // index trong playerIds (chỉ tính alive)
        turnsLeft: 1,                       // Attack cộng thêm lượt
        pendingAction: null,                // { type, sourcePlayer, data } — đang chờ Nope/response
        waitingFor: null,                   // { type, player } — đang chờ player làm gì đó
        insertBombMode: false,              // sau Defuse: player chọn vị trí nhét bom
        log: [],                            // lịch sử sự kiện gần nhất
        phase: 'playing',                   // 'playing' | 'ended'
        winner: null,
    };
}

// ─── Pure Queries ─────────────────────────────────────────────────────────────

function currentPlayer(G) {
    const alive = G.playerIds.filter(id => G.alive.has(id));
    return alive[G.currentTurnIndex % alive.size !== undefined ? G.currentTurnIndex % alive.length : 0];
}

function nextAliveIndex(G, fromIndex, skip = 1) {
    const alive = G.playerIds.filter(id => G.alive.has(id));
    return (fromIndex + skip) % alive.length;
}

function aliveList(G) {
    return G.playerIds.filter(id => G.alive.has(id));
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(G, msg) {
    G.log.push(msg);
    if (G.log.length > 100) G.log.shift();
}

// ─── Core Moves ───────────────────────────────────────────────────────────────

/**
 * Player đánh 1 lá từ tay (trả về { ok, error, effects })
 * effects là mảng event gửi về client
 */
function playCard(G, playerId, cardIndex) {
    if (G.phase !== 'playing') return err('Trò chơi đã kết thúc');
    if (currentPlayer(G) !== playerId) return err('Chưa đến lượt bạn');
    if (G.waitingFor) return err('Đang chờ phản hồi từ người khác');
    if (G.insertBombMode) return err('Đang chờ bạn đặt lại lá Mèo Nổ vào deck');

    const hand = G.hands[playerId];
    if (!hand || cardIndex < 0 || cardIndex >= hand.length) return err('Lá bài không hợp lệ');

    const card = hand[cardIndex];

    // Không thể tự đánh Defuse / ExplodingKitten
    if (card.value === 'Defuse' || card.value === 'ExplodingKitten') {
        return err('Không thể đánh lá này');
    }

    // Với Cat Card phải có cặp
    if (isCat(card)) {
        const pairIdx = hand.findIndex((c, i) => i !== cardIndex && c.value === card.value);
        if (pairIdx === -1) return err('Cần 2 lá mèo cùng loại để đánh cặp');
        // Đánh cặp Cat
        return playCatPair(G, playerId, cardIndex, pairIdx);
    }

    // Mọi lá khác: đưa vào pending để chờ Nope trong 3 giây (server xử lý timeout)
    hand.splice(cardIndex, 1);
    G.discardPile.push(card);

    log(G, `${G.playerNames[playerId]} đánh lá ${card.value}`);

    return resolveCard(G, playerId, card);
}

function playCatPair(G, playerId, i1, i2) {
    const hand = G.hands[playerId];
    const card = hand[i1];
    // Xoá 2 lá (xoá index lớn trước)
    const idxs = [i1, i2].sort((a, b) => b - a);
    idxs.forEach(i => hand.splice(i, 1));
    G.discardPile.push(card, { ...card });

    log(G, `${G.playerNames[playerId]} đánh cặp ${card.value} — chọn người để lấy bài`);

    // Cần chọn nạn nhân
    const others = aliveList(G).filter(id => id !== playerId);
    G.waitingFor = { type: 'cat_choose_target', player: playerId, options: others };
    return ok({ type: 'cat_choose_target', options: others });
}

function resolveCard(G, playerId, card) {
    switch (card.value) {
        case 'Skip': {
            log(G, `${G.playerNames[playerId]} Skip — bỏ lượt rút`);
            advanceTurn(G);
            return ok({ type: 'skip' });
        }
        case 'Attack': {
            log(G, `${G.playerNames[playerId]} Attack — người kế tiếp đi 2 lượt`);
            // Không cần rút bài, chuyển sang người kế
            const alive = aliveList(G);
            G.currentTurnIndex = nextAliveIndex(G, alive.indexOf(playerId));
            G.turnsLeft += 1; // người kế nhận thêm 1 lượt (họ bắt đầu với 1 lượt mặc định)
            return ok({ type: 'attack', target: currentPlayer(G) });
        }
        case 'Shuffle': {
            shuffle(G.deck);
            log(G, `${G.playerNames[playerId]} Shuffle — xáo bài`);
            return ok({ type: 'shuffle' });
        }
        case 'SeeTheFuture': {
            const top3 = G.deck.slice(-3).reverse(); // 3 lá trên đỉnh
            log(G, `${G.playerNames[playerId]} SeeTheFuture`);
            return ok({ type: 'see_future', cards: top3, privatePlayer: playerId });
        }
        case 'Favor': {
            const others = aliveList(G).filter(id => id !== playerId);
            G.waitingFor = { type: 'favor_choose_target', player: playerId, options: others };
            return ok({ type: 'favor_choose_target', options: others });
        }
        default:
            return err('Lá bài chưa được implement');
    }
}

/**
 * Player rút bài (kết thúc lượt)
 */
function drawCard(G, playerId) {
    if (G.phase !== 'playing') return err('Trò chơi đã kết thúc');
    if (currentPlayer(G) !== playerId) return err('Chưa đến lượt bạn');
    if (G.waitingFor) return err('Đang chờ phản hồi từ người khác');
    if (G.insertBombMode) return err('Đang chờ bạn đặt lại lá Mèo Nổ vào deck');
    if (G.deck.length === 0) return err('Deck rỗng');

    const card = G.deck.pop();

    if (card.value === 'ExplodingKitten') {
        const defuseIdx = G.hands[playerId].findIndex(c => c.value === 'Defuse');
        if (defuseIdx !== -1) {
            // Dùng Defuse
            G.hands[playerId].splice(defuseIdx, 1);
            G.discardPile.push({ value: 'Defuse' });
            log(G, `${G.playerNames[playerId]} rút Mèo Nổ — dùng Defuse!`);
            G.insertBombMode = true;
            G.waitingFor = { type: 'insert_bomb', player: playerId, deckSize: G.deck.length };
            return ok({ type: 'defused', player: playerId, deckSize: G.deck.length });
        } else {
            // Bùm!
            G.alive.delete(playerId);
            G.discardPile.push(card);
            log(G, `💥 ${G.playerNames[playerId]} bị loại!`);

            const effect = { type: 'exploded', player: playerId };

            // Kiểm tra thắng
            if (G.alive.size === 1) {
                const winner = aliveList(G)[0];
                G.phase = 'ended';
                G.winner = winner;
                log(G, `🏆 ${G.playerNames[winner]} thắng!`);
                return ok({ type: 'game_over', winner, loser: playerId });
            }

            // Không phải winner — điều chỉnh index
            const alive = aliveList(G);
            G.currentTurnIndex = G.currentTurnIndex % alive.length;
            G.turnsLeft = 1;
            return ok({ type: 'exploded', player: playerId });
        }
    }

    G.hands[playerId].push(card);
    log(G, `${G.playerNames[playerId]} rút bài`);

    // Hết lượt
    G.turnsLeft -= 1;
    if (G.turnsLeft <= 0) {
        advanceTurn(G);
        return ok({ type: 'drew', card, endTurn: true });
    }
    return ok({ type: 'drew', card, endTurn: false });
}

/**
 * Player chọn vị trí nhét bom vào deck (sau Defuse)
 */
function insertBomb(G, playerId, position) {
    if (!G.insertBombMode || !G.waitingFor || G.waitingFor.player !== playerId) {
        return err('Không trong trạng thái nhét bom');
    }
    const pos = Math.max(0, Math.min(position, G.deck.length));
    G.deck.splice(pos, 0, { value: 'ExplodingKitten' });
    G.insertBombMode = false;
    G.waitingFor = null;
    log(G, `${G.playerNames[playerId]} nhét bom vào vị trí ${pos} trong deck`);
    advanceTurn(G);
    return ok({ type: 'bomb_inserted', position: pos, deckSize: G.deck.length });
}

/**
 * Đánh Nope — phủ nhận lá vừa đánh
 * (Nope phải được đánh ngay sau khi server emit pending_action)
 * Có thể đánh Nope lên Nope (Yep)
 */
function playNope(G, playerId) {
    if (!G.pendingAction) return err('Không có hành động nào đang chờ');
    if (playerId === G.pendingAction.sourcePlayer) return err('Không thể Nope chính mình');
    const hand = G.hands[playerId];
    const nopeIdx = hand.findIndex(c => c.value === 'Nope');
    if (nopeIdx === -1) return err('Bạn không có lá Nope');

    hand.splice(nopeIdx, 1);
    G.discardPile.push({ value: 'Nope' });
    // Toggle: Nope bị Nope → hành động vẫn thực hiện
    G.pendingAction.noped = !G.pendingAction.noped;
    log(G, `${G.playerNames[playerId]} đánh Nope!`);
    return ok({ type: 'nope', noped: G.pendingAction.noped });
}

/**
 * Favor: player được chỉ định phải đưa 1 lá cho người yêu cầu
 */
function respondFavor(G, targetId, cardIndex) {
    if (!G.waitingFor || G.waitingFor.type !== 'favor_give_card') return err('Không trong trạng thái Favor');
    if (G.waitingFor.target !== targetId) return err('Không phải lượt của bạn trả lời');

    const hand = G.hands[targetId];
    if (cardIndex < 0 || cardIndex >= hand.length) return err('Lá không hợp lệ');

    const card = hand.splice(cardIndex, 1)[0];
    const requester = G.waitingFor.requester;
    G.hands[requester].push(card);
    G.waitingFor = null;
    log(G, `${G.playerNames[targetId]} đưa 1 lá cho ${G.playerNames[requester]}`);
    return ok({ type: 'favor_done', card, from: targetId, to: requester });
}

/**
 * Chọn nạn nhân cho Favor hoặc Cat
 */
function chooseTarget(G, playerId, targetId) {
    if (!G.waitingFor || G.waitingFor.player !== playerId) return err('Không trong trạng thái chọn người');
    if (!G.alive.has(targetId) || targetId === playerId) return err('Mục tiêu không hợp lệ');

    const type = G.waitingFor.type;

    if (type === 'favor_choose_target') {
        G.waitingFor = { type: 'favor_give_card', requester: playerId, target: targetId };
        return ok({ type: 'favor_waiting', target: targetId });
    }

    if (type === 'cat_choose_target') {
        const targetHand = G.hands[targetId];
        if (targetHand.length === 0) {
            G.waitingFor = null;
            log(G, `${G.playerNames[targetId]} không còn lá nào để mất`);
            return ok({ type: 'cat_empty_hand', target: targetId });
        }
        // KHÔNG bốc tự động nữa — chuyển sang chờ chính playerId tự chọn
        // 1 trong các lá úp (chỉ biết vị trí, không biết nội dung) của targetId.
        log(G, `${G.playerNames[playerId]} chọn ${G.playerNames[targetId]} — đang tự bốc 1 lá...`);
        G.waitingFor = { type: 'cat_choose_card', player: playerId, target: targetId, handSize: targetHand.length };
        return ok({ type: 'cat_choose_card', target: targetId, handSize: targetHand.length });
    }

    return err('Trạng thái không hợp lệ');
}

/**
 * Sau khi đã chọn nạn nhân cho Cat pair, playerId tự chọn 1 vị trí (mù — không
 * biết nội dung) trong tay nạn nhân để "bốc" lấy lá đó.
 */
function chooseStolenCard(G, playerId, cardIndex) {
    if (!G.waitingFor || G.waitingFor.type !== 'cat_choose_card' || G.waitingFor.player !== playerId) {
        return err('Không trong trạng thái tự bốc lá ăn trộm');
    }
    const targetId = G.waitingFor.target;
    const targetHand = G.hands[targetId];
    if (!targetHand || targetHand.length === 0) {
        G.waitingFor = null;
        return err('Người chơi không còn lá nào');
    }
    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= targetHand.length) {
        return err('Vị trí lá không hợp lệ');
    }

    const stolenCard = targetHand.splice(cardIndex, 1)[0];
    G.hands[playerId].push(stolenCard);
    G.waitingFor = null;
    log(G, `${G.playerNames[playerId]} ăn trộm 1 lá từ ${G.playerNames[targetId]}`);
    return ok({ type: 'cat_done', stolen: stolenCard, from: targetId, to: playerId });
}

// ─── Turn Management ──────────────────────────────────────────────────────────

function advanceTurn(G) {
    const alive = aliveList(G);
    G.currentTurnIndex = (G.currentTurnIndex + 1) % alive.length;
    G.turnsLeft = 1;
}

// ─── Bot AI ───────────────────────────────────────────────────────────────────

/**
 * Quyết định bot sẽ làm gì trong lượt.
 * Trả về action object: { action: 'play'|'draw', cardIndex?, ... }
 */
function botDecide(G, botId) {
    const hand = G.hands[botId];
    if (!hand) return { action: 'draw' };

    // Nếu đang waitingFor từ bot
    if (G.waitingFor) {
        const wf = G.waitingFor;
        if (wf.type === 'favor_give_card' && wf.target === botId) {
            // Đưa lá không quan trọng nhất (không Defuse, không Nope)
            const idx = hand.findIndex(c => c.value !== 'Defuse' && c.value !== 'Nope') ?? 0;
            return { action: 'respond_favor', cardIndex: idx >= 0 ? idx : 0 };
        }
        if ((wf.type === 'favor_choose_target' || wf.type === 'cat_choose_target') && wf.player === botId) {
            const targets = wf.options.filter(id => id !== botId && G.alive.has(id));
            // Chọn người có nhiều bài nhất
            const target = targets.sort((a, b) => G.hands[b].length - G.hands[a].length)[0];
            return { action: 'choose_target', targetId: target };
        }
        if (wf.type === 'cat_choose_card' && wf.player === botId) {
            // Bot bốc mù ngẫu nhiên 1 vị trí, giống người chơi thật
            return { action: 'choose_stolen_card', cardIndex: randInt(wf.handSize) };
        }
        if (wf.type === 'insert_bomb' && wf.player === botId) {
            // Nhét bom vào giữa deck
            const pos = Math.floor(G.deck.length / 2);
            return { action: 'insert_bomb', position: pos };
        }
        return { action: 'wait' };
    }

    // Ưu tiên 1: Đánh Skip nếu deck nhỏ < 4 lá (nguy hiểm)
    if (G.deck.length < 4) {
        const skipIdx = hand.findIndex(c => c.value === 'Skip');
        if (skipIdx !== -1) return { action: 'play', cardIndex: skipIdx };

        const attackIdx = hand.findIndex(c => c.value === 'Attack');
        if (attackIdx !== -1) return { action: 'play', cardIndex: attackIdx };
    }

    // Ưu tiên 2: Đánh SeeTheFuture nếu có
    const seeIdx = hand.findIndex(c => c.value === 'SeeTheFuture');
    if (seeIdx !== -1 && Math.random() > 0.3) return { action: 'play', cardIndex: seeIdx };

    // Ưu tiên 3: Đánh Cat pair nếu có
    for (const cat of CAT_TYPES) {
        const indices = hand.reduce((acc, c, i) => c.value === cat ? [...acc, i] : acc, []);
        if (indices.length >= 2) return { action: 'play', cardIndex: indices[0] };
    }

    // Mặc định: rút bài
    return { action: 'draw' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(data) { return { ok: true, ...data }; }
function err(msg) { return { ok: false, error: msg }; }

// ─── Public view ──────────────────────────────────────────────────────────────

/**
 * Trả về state an toàn cho player (ẩn tay bài người khác)
 */
function getPlayerView(G, playerId) {
    const view = {
        playerIds: G.playerIds,
        playerNames: G.playerNames,
        alive: Array.from(G.alive),
        myHand: G.hands[playerId] || [],
        handSizes: {},
        deckSize: G.deck.length,
        discardPile: G.discardPile,
        currentPlayer: currentPlayer(G),
        turnsLeft: G.turnsLeft,
        waitingFor: G.waitingFor,
        insertBombMode: G.insertBombMode && G.waitingFor?.player === playerId,
        phase: G.phase,
        winner: G.winner,
        log: G.log.slice(-20),
        botIndexes: G.botIndexes,
    };
    G.playerIds.forEach(id => {
        view.handSizes[id] = G.hands[id]?.length || 0;
    });
    return view;
}

module.exports = {
    createGame,
    playCard,
    drawCard,
    insertBomb,
    playNope,
    respondFavor,
    chooseTarget,
    chooseStolenCard,
    botDecide,
    currentPlayer,
    aliveList,
    getPlayerView,
    CAT_TYPES,
};