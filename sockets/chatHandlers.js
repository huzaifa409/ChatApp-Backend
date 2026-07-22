const pool = require('../config/db');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads'); // adjust based on actual folder location relative to chatHandlers.js

// Consistent, sorted room name for any pair of users — so both sides always compute the same name
function getConversationRoomName(xidA, xidB) {
  return [xidA, xidB].sort().join('_');
}

const MEDIA_PREVIEW = {
  image: 'Photo',
  video: 'Video',
  document: 'Document',
};

function registerChatHandlers(io, socket, onlineUsers) {

socket.on('register', async (xid) => {
  onlineUsers.set(xid, socket.id);
  socket.data.xid = xid;
  socket.join(xid);

  console.log(`XID ${xid} registered on socket ${socket.id}, joined personal room`);

  try {
    const [pendingMessages] = await pool.query(
      `SELECT * FROM messages
       WHERE receiver_xid = ? AND delivered_to_receiver = FALSE AND deleted_for_everyone = FALSE
       ORDER BY created_at ASC`,
      [xid]
    );

    pendingMessages.forEach((msg) => {
      io.to(xid).emit('newMessage', msg);
    });

    // NEW: also let the sidebar know about these conversations/names,
    // since normal 'conversationUpdate' only fires for real-time sends,
    // not for messages that were sitting pending in MySQL.
    if (pendingMessages.length > 0) {
      const uniqueSenders = [...new Set(pendingMessages.map((m) => m.sender_xid))];
      const [nameRows] = await pool.query(
        `SELECT xid, name FROM users WHERE xid IN (${uniqueSenders.map(() => '?').join(',')})`,
        uniqueSenders
      );
      const nameMap = {};
      nameRows.forEach((row) => { nameMap[row.xid] = row.name; });

      uniqueSenders.forEach((senderXid) => {
        const lastMsg = [...pendingMessages].reverse().find((m) => m.sender_xid === senderXid);
        const previewText =
          lastMsg.message_type === 'text' ? lastMsg.message_text :
          lastMsg.message_type === 'image' ? 'Photo' :
          lastMsg.message_type === 'video' ? 'Video' :
          (lastMsg.message_text || 'Document');

        io.to(xid).emit('conversationUpdate', {
          other_xid: senderXid,
          other_name: nameMap[senderXid],
          last_message: previewText,
          last_time: lastMsg.created_at,
        });
      });
    }

    const [pendingDeletes] = await pool.query(
      `SELECT id, sender_xid, receiver_xid, created_at FROM messages WHERE receiver_xid = ? AND deleted_for_everyone = TRUE`,
      [xid]
    );

    pendingDeletes.forEach((row) => {
      io.to(xid).emit('messageDeletedForEveryone', {
        id: row.id,
        sender_xid: row.sender_xid,
        receiver_xid: row.receiver_xid,
        created_at: row.created_at
      });
    });

    if (pendingDeletes.length > 0) {
      const ids = pendingDeletes.map((row) => row.id);
      await pool.query('DELETE FROM messages WHERE id IN (?)', [ids]);
    }
  } catch (err) {
    console.error('register pending-sync error:', err);
  }
});


  socket.on('messageDelivered', async ({ messageId, userXid }) => {
  try {
    const [rows] = await pool.query('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (rows.length === 0) return;

    const message = rows[0];
    if (message.receiver_xid !== userXid) return; // only the actual receiver can ack

    // For media messages, the receiver has now confirmed it's saved locally —
    // the server's copy on disk is no longer needed.
    if (message.message_type !== 'text' && message.media_data) {
      const filename = message.media_data.split('/').pop();
      const filePath = path.join(UPLOAD_DIR, filename);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') {
          console.error('Failed to delete media file after delivery ack:', err);
        }
      });
    }

    await pool.query('DELETE FROM messages WHERE id = ?', [messageId]);
  } catch (err) {
    console.error('messageDelivered error:', err);
  }
});

  // Client opens a specific chat — join the shared conversation room
  socket.on('joinConversation', ({ myXid, otherXid }) => {
    const roomName = getConversationRoomName(myXid, otherXid);
    socket.join(roomName);
    console.log(`Socket ${socket.id} joined conversation room ${roomName}`);
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

      socket.emit('conversationHistory', { otherXid, messages: rows });
    } catch (err) {
      console.error('getHistory error:', err);
      socket.emit('errorMessage', { error: 'Could not load conversation history.' });
    }
  });

  // Client asks for their full conversation list (for the left panel)
  socket.on('getConversations', async ({ myXid }) => {
    try {
      const [rows] = await pool.query(
        `SELECT other_xid, u.name AS other_name, t.last_message, t.last_time
         FROM (
           SELECT
             CASE WHEN sender_xid = ? THEN receiver_xid ELSE sender_xid END AS other_xid,
             CASE
               WHEN message_type = 'image' THEN 'Photo'
               WHEN message_type = 'video' THEN 'Video'
               WHEN message_type = 'document' THEN 'Document'
               ELSE message_text
             END AS last_message,
             created_at AS last_time,
             ROW_NUMBER() OVER (
               PARTITION BY CASE WHEN sender_xid = ? THEN receiver_xid ELSE sender_xid END
               ORDER BY created_at DESC
             ) AS rn
           FROM messages
           WHERE sender_xid = ? OR receiver_xid = ?
         ) t
         JOIN users u ON u.xid = t.other_xid
         WHERE t.rn = 1
         ORDER BY t.last_time DESC`,
        [myXid, myXid, myXid, myXid]
      );

      socket.emit('conversationsList', rows);
    } catch (err) {
      console.error('getConversations error:', err);
      socket.emit('errorMessage', { error: 'Could not load conversations.' });
    }
  });


  socket.on('sendMessage', async ({ senderXid, receiverXid, text }) => {
  try {
    if (!senderXid || !receiverXid || !text || !text.trim()) return;

    const [result] = await pool.query(
      'INSERT INTO messages (sender_xid, receiver_xid, message_text, message_type) VALUES (?, ?, ?, ?)',
      [senderXid, receiverXid, text.trim(), 'text']
    );

    const savedMessage = {
      id: result.insertId,
      sender_xid: senderXid,
      receiver_xid: receiverXid,
      message_text: text.trim(),
      message_type: 'text',
      media_data: null,
      created_at: new Date(),
    };

    // Always emit to the room — the sender is always in it and needs their own echo
    // to save the message locally. If the receiver happens to be offline, Socket.IO
    // simply won't deliver to their (disconnected) socket — the row stays pending
    // in MySQL and gets replayed via the 'register' handler when they reconnect.
    const roomName = getConversationRoomName(senderXid, receiverXid);
    io.to(roomName).emit('newMessage', savedMessage);

    const [nameRows] = await pool.query(
      'SELECT xid, name FROM users WHERE xid IN (?, ?)',
      [senderXid, receiverXid]
    );
    const nameMap = {};
    nameRows.forEach(row => { nameMap[row.xid] = row.name; });

    io.to(receiverXid).emit('conversationUpdate', {
      other_xid: senderXid,
      other_name: nameMap[senderXid],
      last_message: text.trim(),
      last_time: savedMessage.created_at,
    });

    io.to(senderXid).emit('conversationUpdate', {
      other_xid: receiverXid,
      other_name: nameMap[receiverXid],
      last_message: text.trim(),
      last_time: savedMessage.created_at,
    });

  } catch (err) {
    console.error('sendMessage error:', err);
    socket.emit('errorMessage', { error: 'Could not send message.' });
  }
});


  socket.on('sendMediaMessage', async ({ senderXid, receiverXid, mediaUrl, messageType, fileName }) => {
  try {
    if (!senderXid || !receiverXid || !mediaUrl || !messageType) return;
    if (!['image', 'video', 'document'].includes(messageType)) return;

    const textToStore = messageType === 'document' ? (fileName || '') : '';

    const [result] = await pool.query(
      'INSERT INTO messages (sender_xid, receiver_xid, message_text, message_type, media_data) VALUES (?, ?, ?, ?, ?)',
      [senderXid, receiverXid, textToStore, messageType, mediaUrl]
    );

    const savedMessage = {
      id: result.insertId,
      sender_xid: senderXid,
      receiver_xid: receiverXid,
      message_text: textToStore,
      message_type: messageType,
      media_data: mediaUrl,
      created_at: new Date(),
    };

    // Same rule as sendMessage — always emit to the room so the sender gets their
    // own echo (needed to swap in the original local file path and save locally).
    const roomName = getConversationRoomName(senderXid, receiverXid);
    io.to(roomName).emit('newMessage', savedMessage);

    const [nameRows] = await pool.query(
      'SELECT xid, name FROM users WHERE xid IN (?, ?)',
      [senderXid, receiverXid]
    );
    const nameMap = {};
    nameRows.forEach(row => { nameMap[row.xid] = row.name; });

    const previewText = MEDIA_PREVIEW[messageType];

    io.to(receiverXid).emit('conversationUpdate', {
      other_xid: senderXid,
      other_name: nameMap[senderXid],
      last_message: previewText,
      last_time: savedMessage.created_at,
    });

    io.to(senderXid).emit('conversationUpdate', {
      other_xid: receiverXid,
      other_name: nameMap[receiverXid],
      last_message: previewText,
      last_time: savedMessage.created_at,
    });

    console.log(`[media] ${messageType} ${mediaUrl} saved as message id=${result.insertId}`);

  } catch (err) {
    console.error('sendMediaMessage DB error:', err);
    socket.emit('errorMessage', { error: 'Failed to save file. Try again.' });
  }
});

  // ---------- Delete for Everyone ----------
  socket.on('deleteMessageForEveryone', async ({ messageId, senderXid, receiverXid, createdAt, userXid }) => {
  try {
    // Authorization — only the sender can delete for everyone
    if (senderXid !== userXid) {
      return socket.emit('errorMessage', { error: 'Not authorized to delete this message.' });
    }

    const roomName = getConversationRoomName(senderXid, receiverXid);

    const [rows] = await pool.query(
      'SELECT * FROM messages WHERE id = ?',
      [messageId]
    );

    if (rows.length > 0) {
      const message = rows[0];

      // If it has media, remove the file from disk (regardless of online/offline path)
      if (message.media_data) {
        const filename = message.media_data.split('/').pop();
        const filePath = path.join(UPLOAD_DIR, filename);
        fs.unlink(filePath, (err) => {
          if (err && err.code !== 'ENOENT') {
            console.error('Failed to delete media file:', err);
          }
        });
      }

      if (onlineUsers.has(receiverXid)) {
        // Receiver is online — delete outright since they'll get the real-time event
        await pool.query('DELETE FROM messages WHERE id = ?', [messageId]);
      } else {
        // Receiver is offline — leave a tombstone row instead of deleting outright
        await pool.query(
          `UPDATE messages
           SET deleted_for_everyone = TRUE, message_text = NULL, media_data = NULL, message_type = 'deleted'
           WHERE id = ?`,
          [messageId]
        );
      }
    } else {
      // Message NOT in DB (meaning it was already delivered and deleted, OR it never existed)
      // Since it was delivered, the receiver already has it on their device.
      if (!onlineUsers.has(receiverXid)) {
        // Receiver is offline. They already received it previously, but we need to tell them 
        // to delete it when they come back online. So we MUST insert a tombstone row!
        try {
          // Note: createdAt comes in as an ISO string from the frontend, MySQL can parse it
          const parsedDate = new Date(createdAt);
          const formattedDate = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
          
          await pool.query(
            `INSERT INTO messages (id, sender_xid, receiver_xid, message_text, message_type, deleted_for_everyone, created_at)
             VALUES (?, ?, ?, NULL, 'deleted', TRUE, ?)`,
            [messageId, senderXid, receiverXid, formattedDate]
          );
        } catch (err) {
          console.error('Failed to insert tombstone:', err);
        }
      }
    }

    // Always emit the delete event to the room so the sender (and receiver if online) updates locally
    io.to(roomName).emit('messageDeletedForEveryone', { 
      id: messageId,
      sender_xid: senderXid,
      receiver_xid: receiverXid,
      created_at: createdAt
    });

    console.log(`[delete] message id=${messageId} deleted for everyone by ${userXid}`);

  } catch (err) {
    console.error('deleteMessageForEveryone error:', err);
    socket.emit('errorMessage', { error: 'Could not delete message.' });
  }
});

  // ---------- Delete for Me ----------
  socket.on('deleteMessageForMe', async ({ messageId, userXid }) => {
    try {
      const [rows] = await pool.query(
        'SELECT * FROM messages WHERE id = ?',
        [messageId]
      );

      if (rows.length === 0) {
        // Already delivered and deleted from server. Just succeed locally.
        return socket.emit('messageDeletedForMe', { id: messageId });
      }

      const message = rows[0];

      // Must be a participant in the conversation
      if (message.sender_xid !== userXid && message.receiver_xid !== userXid) {
        return socket.emit('errorMessage', { error: 'Not authorized to delete this message.' });
      }

      // If the RECEIVER is deleting it for themselves, we can delete the server copy.
      // If the SENDER is deleting it for themselves, they just don't want to see it anymore, 
      // but we MUST NOT delete it from the server, because the receiver hasn't received it yet!
      if (message.receiver_xid === userXid) {
        if (message.media_data) {
          const filename = message.media_data.split('/').pop();
          const filePath = path.join(UPLOAD_DIR, filename);
          fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') {
              console.error('Failed to delete media file:', err);
            }
          });
        }
        await pool.query('DELETE FROM messages WHERE id = ?', [messageId]);
      }

      // Only tell the requesting user's own socket — no broadcast to the room
      socket.emit('messageDeletedForMe', { id: messageId });

      console.log(`[delete] message id=${messageId} deleted for me by ${userXid}`);

    } catch (err) {
      console.error('deleteMessageForMe error:', err);
      socket.emit('errorMessage', { error: 'Could not delete message.' });
    }
  });



  socket.on('disconnect', () => {
    if (socket.data.xid) {
      onlineUsers.delete(socket.data.xid);
      console.log(`XID ${socket.data.xid} disconnected`);
    }
  });
}

module.exports = registerChatHandlers;