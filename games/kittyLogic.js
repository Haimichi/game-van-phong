const { PlayerView } = require('boardgame.io/dist/cjs/core.js');

const KittenGame = {
    name: 'kitten',
    setup: (ctx) => {
        let deck = [];
        // Khởi tạo deck bài mèo nổ cơ bản
        for (let i = 0; i < 4; i++) deck.push({ value: 'SeeTheFuture' }, { value: 'Skip' }, { value: 'Attack' });
        deck = ctx.random.Shuffle(deck);

        let hands = {};
        for (let i = 0; i < ctx.numPlayers; i++) {
            hands[i] = [{ value: 'Defuse' }]; // Mỗi người mặc định có 1 lá gỡ bom
            hands[i].push(...deck.splice(0, 4)); // Chia thêm 4 lá
        }

        // Nhồi bom vào deck tương ứng số người chơi
        for (let i = 0; i < ctx.numPlayers - 1; i++) deck.push({ value: 'ExplodingKitten' });
        deck = ctx.random.Shuffle(deck);

        return {
            deck,
            hands,
            discardPile: [],
            loser: null
        };
    },

    playerView: PlayerView.STRIP_SECRETS,

    moves: {
        drawCard: (G, ctx) => {
            const card = G.deck.pop();
            if (card.value === 'ExplodingKitten') {
                const defuseIdx = G.hands[ctx.currentPlayer].findIndex(c => c.value === 'Defuse');
                if (defuseIdx !== -1) {
                    G.hands[ctx.currentPlayer].splice(defuseIdx, 1); // Mất xài lá Defuse
                    G.deck.push({ value: 'ExplodingKitten' }); // Nhét bom lại vào deck
                    G.deck = ctx.random.Shuffle(G.deck);
                } else {
                    G.loser = ctx.currentPlayer; // Bùm! Bị loại
                }
            } else {
                G.hands[ctx.currentPlayer].push(card);
            }
            ctx.events.endTurn();
        },
        playAction: (G, ctx, cardIndex) => {
            const hand = G.hands[ctx.currentPlayer];
            const card = hand[cardIndex];
            if (card.value === 'Skip') {
                hand.splice(cardIndex, 1);
                G.discardPile.push(card);
                ctx.events.endTurn();
            }
        }
    }
};

module.exports = { KittenGame };