const { Server, Origins } = require('boardgame.io/server');
const { UnoGame } = require('./games/unoLogic');

// Danh sách các origin được phép kết nối tới Socket.io của boardgame.io.
// Origins.LOCALHOST đã cho phép mọi origin dạng http://localhost:* và
// http://127.0.0.1:*, nên không cần khai báo lại từng cổng.
// Nếu chơi qua mạng LAN (nhiều máy khác nhau), hãy thêm địa chỉ IP/host
// thật của máy chạy server vào danh sách dưới đây, ví dụ:
//   'http://192.168.1.10:3000'
const allowedOrigins = [
    Origins.LOCALHOST,
];

if (process.env.EXTRA_ORIGIN) {
    // Cho phép truyền thêm 1 origin qua biến môi trường khi deploy/chạy LAN
    // VD: EXTRA_ORIGIN=http://192.168.1.10:3000 node bgio-server.js
    allowedOrigins.push(process.env.EXTRA_ORIGIN);
}

const server = Server({
    games: [UnoGame],
    origins: allowedOrigins,
});

const PORT = process.env.BGIO_PORT || 8000;
server.run(PORT, () => {
    console.log(`🎲 Engine Boardgame.io đang chạy tại: http://localhost:${PORT}`);
});