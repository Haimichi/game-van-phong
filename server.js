const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Cấp quyền cho Express đọc các file giao diện tĩnh
app.use(express.static('public'));

// Cấu hình đường dẫn cho các phòng game
app.get('/uno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'uno', 'index.html')));
app.get('/chess', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chess', 'index.html')));

io.on('connection', (socket) => {
    console.log(`[+] Có người vào Đại sảnh: ${socket.id}`);

    // Nhận tin nhắn chat ở Đại sảnh và gửi cho tất cả mọi người
    socket.on('lobby-chat', (data) => {
        io.emit('lobby-chat', data);
    });

    socket.on('disconnect', () => {
        console.log(`[-] Đã thoát: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
});