const pool = require('../config/db');


function generateXid() {
  let xid = '';
  for (let i = 0; i < 9; i++) {
    xid += Math.floor(Math.random() * 10); 
  }
  return xid;
}


async function generateUniqueXid() {
  let xid;
  let exists = true;

  while (exists) {
    xid = generateXid();
    const [rows] = await pool.query('SELECT id FROM users WHERE xid = ?', [xid]);
    exists = rows.length > 0;
  }

  return xid;
}

module.exports = generateUniqueXid;