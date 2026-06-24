// ==========================================================
// UNO GAME LOGIC — LUẬT CHUẨN (boardgame.io 0.50.2)
//
// FIX CHÍNH:
// 1. Lá chức năng được xử lý ĐÚNG THỨ TỰ trước endTurn
// 2. +2/+4 không chồng (ALLOW_STACKING = false)
// 3. Người bị phạt KHÔNG được đánh bài trong lượt đó
// 4. Người bị phạt phải tự click "Rút bài" (không tự động rút)
// 5. Skip/Reverse xử lý chiều đúng
// ==========================================================

const ALLOW_STACKING = false;

function createUnoDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    let deck = [];
    colors.forEach(color => {
        deck.push({ color, value: '0' });
        for (let i = 1; i <= 9; i++) {
            deck.push({ color, value: i.toString() }, { color, value: i.toString() });
        }
        ['Skip', 'Reverse', '+2'].forEach(act => {
            deck.push({ color, value: act }, { color, value: act });
        });
    });
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'Wild' }, { color: 'black', value: '+4' });
    }
    return deck;
}

function drawFromDeck(G, random, count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
        if (G.deck.length === 0) {
            if (G.discardPile.length <= 1) break;
            const top = G.discardPile.pop();
            G.deck = random.Shuffle(G.discardPile.map(c => ({ ...c })));
            G.deck = G.deck.map(c => {
                if (c.value === 'Wild' || c.value === '+4') return { ...c, color: 'black' };
                return c;
            });
            G.discardPile = [top];
        }
        const card = G.deck.pop();
        if (card) drawn.push(card);
    }
    return drawn;
}

function getNextPlayer(currentPlayer, direction, numPlayers, steps = 1) {
    return (parseInt(currentPlayer) + (direction * steps) + numPlayers * 10) % numPlayers;
}

const VALID_COLORS = ['red', 'blue', 'green', 'yellow'];

const UnoGame = {
    name: 'uno',

    setup: ({ ctx, random }) => {
        const hands = {};
        for (let i = 0; i < ctx.numPlayers; i++) hands[i] = [];
        return {
            deck: random.Shuffle(createUnoDeck()),
            hands,
            discardPile: [],
            isStarted: false,
            direction: 1,
            winner: null,
            forcedDrawCount: 0,      // Số lá phải rút (0 = không bị phạt)
            forcedDrawPlayer: null,  // Ai bị ép rút (không được đánh)
            lastAction: null,
            unoAlert: null,
        };
    },

    moves: {
        startGame: ({ G, ctx, random }) => {
            if (G.isStarted) return 'INVALID_MOVE';
            G.isStarted = true;
            G.lastAction = null;
            G.unoAlert = null;
            G.forcedDrawPlayer = null;
            G.forcedDrawCount = 0;

            for (let i = 0; i < ctx.numPlayers; i++) {
                G.hands[i] = drawFromDeck(G, random, 7);
            }

            const setAside = [];
            let firstCard = G.deck.pop();
            while (firstCard && firstCard.color === 'black') {
                setAside.push(firstCard);
                firstCard = G.deck.pop();
            }
            if (setAside.length) G.deck = G.deck.concat(setAside);
            if (firstCard) G.discardPile.push(firstCard);
        },

        playCard: ({ G, ctx, events, random }, cardIndex, wildColor) => {
            if (!G.isStarted) return 'INVALID_MOVE';

            const hand = G.hands[ctx.currentPlayer];
            const card = hand && hand[cardIndex];
            if (!card) return 'INVALID_MOVE';

            const topCard = G.discardPile[G.discardPile.length - 1];
            const topColor = topCard.chosenColor || topCard.color;

            // Kiểm tra bài có đánh được không
            const isMatch =
                card.color === topColor ||
                card.value === topCard.value ||
                card.color === 'black';

            if (!isMatch) return 'INVALID_MOVE';

            // Wild/+4 phải chọn màu hợp lệ
            if (card.color === 'black' && !VALID_COLORS.includes(wildColor)) {
                return 'INVALID_MOVE';
            }

            // ✓ FIX: Nếu người này bị ép rút từ +2/+4 trước, không được đánh
            if (G.forcedDrawPlayer === ctx.currentPlayer) {
                return 'INVALID_MOVE';
            }

            // Xóa lá khỏi tay
            hand.splice(cardIndex, 1);

            // Lưu card vào discard
            const playedCard = { ...card };
            if (card.color === 'black' && wildColor) {
                playedCard.chosenColor = wildColor;
            }
            G.discardPile.push(playedCard);

            G.lastAction = { type: 'play', player: ctx.currentPlayer, card: playedCard };
            G.unoAlert = null;
            G.forcedDrawPlayer = null; // Clear vì người này đã đánh bài
            G.forcedDrawCount = 0;

            // Kiểm tra thắng
            if (hand.length === 0) {
                G.winner = ctx.currentPlayer;
                return;
            }

            // Báo UNO
            if (hand.length === 1) {
                G.unoAlert = ctx.currentPlayer;
            }

            const numPlayers = ctx.numPlayers;
            let nextPlayer = getNextPlayer(ctx.currentPlayer, G.direction, numPlayers);

            // ✓ FIX: Xử lý lá chức năng ĐÚNG THỨ TỰ
            if (card.value === 'Reverse') {
                // Đổi chiều
                G.direction *= -1;
                if (numPlayers === 2) {
                    // 2 người: Reverse = Skip (bỏ lượt người kế)
                    nextPlayer = getNextPlayer(ctx.currentPlayer, G.direction, numPlayers, 2);
                } else {
                    // 3+ người: Reverse chỉ đổi chiều, lấy người kế theo chiều mới
                    nextPlayer = getNextPlayer(ctx.currentPlayer, G.direction, numPlayers);
                }
            } else if (card.value === 'Skip') {
                // Bỏ lượt người kế (không đổi chiều)
                nextPlayer = getNextPlayer(ctx.currentPlayer, G.direction, numPlayers, 2);
            } else if (card.value === '+2') {
                // ✓ THAY ĐỔI: Không tự động rút, chỉ đánh dấu
                nextPlayer = getNextPlayer(ctx.currentPlayer, G.direction, numPlayers);
                G.forcedDrawCount = 2;
                G.forcedDrawPlayer = nextPlayer;
                G.lastAction.penalty = 2;
                // KHÔNG bỏ qua - để player kế phải rút thủ công
            } else if (card.value === '+4') {
                // ✓ THAY ĐỔI: Không tự động rút, chỉ đánh dấu
                nextPlayer = getNextPlayer(ctx.currentPlayer, G.direction, numPlayers);
                G.forcedDrawCount = 4;
                G.forcedDrawPlayer = nextPlayer;
                G.lastAction.penalty = 4;
                // KHÔNG bỏ qua - để player kế phải rút thủ công
            }

            events.endTurn({ next: nextPlayer.toString() });
        },

        drawCard: ({ G, ctx, events, random }) => {
            if (!G.isStarted) return 'INVALID_MOVE';

            // Nếu bị ép rút, chỉ rút đúng số lá bị phạt
            let drawCount = G.forcedDrawCount > 0 ? G.forcedDrawCount : 1;

            const drawn = drawFromDeck(G, random, drawCount);
            G.hands[ctx.currentPlayer].push(...drawn);
            G.lastAction = { type: 'draw', player: ctx.currentPlayer, count: drawCount };
            G.unoAlert = null;
            G.forcedDrawPlayer = null;  // Clear sau khi rút
            G.forcedDrawCount = 0;      // Clear số lá phải rút

            const nextPlayer = getNextPlayer(ctx.currentPlayer, G.direction, ctx.numPlayers);
            events.endTurn({ next: nextPlayer.toString() });
        }
    },

    endIf: ({ G }) => {
        if (G.winner !== undefined && G.winner !== null && G.winner !== '') {
            return { winner: G.winner };
        }
        return false;
    },

    playerView: ({ G, ctx, playerID }) => {
        const hiddenHands = {};
        for (const pid in G.hands) {
            if (pid === playerID) {
                hiddenHands[pid] = G.hands[pid];
            } else {
                hiddenHands[pid] = G.hands[pid].map(() => ({ color: 'hidden', value: '?' }));
            }
        }
        return {
            ...G,
            hands: hiddenHands,
            deck: [],
            deckCount: G.deck.length
        };
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UnoGame };
} else {
    window.UnoGame = UnoGame;
}
