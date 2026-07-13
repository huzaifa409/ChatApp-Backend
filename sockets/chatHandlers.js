const pool = require('../config/db');

function registerChatHandlers(io, socket, onlineUsers) {

  // Client tells the server "this socket belongs to XID X"
  socket.on('register', (xid) => {
    onlineUsers.set(xid, socket.id);
    socket.data.xid = xid; // remember it on the socket itself too
    console.log(`XID ${xid} registered on socket ${socket.id}`);
  });

  // Client asks for chat history with another user
  socket.on('getHistory', async ({ myXid, otherXid }) => {
    try {
      const [rows] = await pool.query(
        `SELECT * FROM messages
         WHERE (sender_xid = ? AND receiver_xid = ?)
            OR (sender_xid = ? AND receiver_xid = ?)
         ORDER BY created_at ASC`,
        [myXid, otherXid, otherXid, myXid]
      );

      // Send history back only to the requester
      socket.emit('conversationHistory', { otherXid, messages: rows });
    } catch (err) {
      console.error('getHistory error:', err);
      socket.emit('errorMessage', { error: 'Could not load conversation history.' });
    }
  });

  // Client sends a new message
  socket.on('sendMessage', async ({ senderXid, receiverXid, text }) => {
    try {
      if (!senderXid || !receiverXid || !text || !text.trim()) return;

      const [result] = await pool.query(
        'INSERT INTO messages (sender_xid, receiver_xid, message_text) VALUES (?, ?, ?)',
        [senderXid, receiverXid, text.trim()]
      );

      const savedMessage = {
        id: result.insertId,
        sender_xid: senderXid,
        receiver_xid: receiverXid,
        message_text: text.trim(),
        created_at: new Date(),
      };

      // Send it back to the sender (so their UI updates immediately)
      socket.emit('newMessage', savedMessage);

      // If the receiver is currently online, push it to them too
      const receiverSocketId = onlineUsers.get(receiverXid);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('newMessage', savedMessage);
      }

    } catch (err) {
      console.error('sendMessage error:', err);
      socket.emit('errorMessage', { error: 'Could not send message.' });
    }
  });

  // Cleanup when this socket disconnects
  socket.on('disconnect', () => {
    if (socket.data.xid) {
      onlineUsers.delete(socket.data.xid);
      console.log(`XID ${socket.data.xid} disconnected`);
    }
  });
}

module.exports = registerChatHandlers;