const pool = require('../config/db');



async function searchUsers(req, res) {
    try {

        const { query } = req.query;

        if (!query || query.trim().length === 0) {

            return res.status(200).json({ users: [] });
        }

        const searchTerm = `%${query.trim()}%`;

        const [rows] = await pool.query
            ('SELECT name, xid FROM users WHERE xid LIKE ? LIMIT 5',
                [searchTerm]
            );
        res.status(200).json({ users: rows });

    }
    catch (err) {
        console.error('Search error: ', err);
        res.status(500).json({ error: 'Something Went Wrong, Please Try Again' })
    }

}




module.exports = { searchUsers };