const bcrypt = require('bcrypt');
const pool = require('../config/db');
const generateUniqueXid = require('../utils/generateXid');

///////////     Register 
async function register(req, res) {
  try {
    const { name, pin } = req.body;

    if (!name || !pin) {
      return res.status(400).json({ error: 'Name and Pin are required.' });
    }
    if (typeof pin !== 'string' || pin.length < 4) {
      return res.status(400).json({ error: 'Pin must be at least 4 digits.' });
    }

    const pinHash = await bcrypt.hash(pin, 10);
    const xid = await generateUniqueXid();

    await pool.query(
      'INSERT INTO users (name, pin_hash, xid) VALUES (?, ?, ?)',
      [name, pinHash, xid]
    );

    res.status(201).json({ message: 'Registered successfully!', xid });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}






////// Login

async function login(req, res) {
  try {
    const { identifier, pin } = req.body;
    

    if (!identifier || !pin) {
      return res.status(400).json({ error: 'Name/Xid and Pin are required.' });
    }

   
    const [rows] = await pool.query(
      'SELECT id, name, pin_hash, xid FROM users WHERE name = ? OR xid = ?',
      [identifier, identifier]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'User not found.' });
    }

    const user = rows[0];

    
    const isMatch = await bcrypt.compare(pin, user.pin_hash);

    if (!isMatch) {
      return res.status(401).json({ error: 'Incorrect PIN.' });
    }

   
    res.status(200).json({
      message: 'Login successful!',
      user: {
        name: user.name,
        xid: user.xid,
      },
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

module.exports = { register, login };