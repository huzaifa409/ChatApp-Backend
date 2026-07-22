require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const registerChatHandlers = require('./sockets/chatHandlers');


const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/upload', require('./routes/uploadRoutes'));


const path = require('path');

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/', (req, res) => {
  res.send('Messenger backend is running.');
});


const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: '*', 
  },
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('New socket connected:', socket.id);
  registerChatHandlers(io, socket, onlineUsers);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});