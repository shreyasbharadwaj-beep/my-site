require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname), {
    index: 'index.html',
    extensions: ['html']
}));

// Route /api/* to serverless functions in api/
app.post('/api/chat', require('./api/chat'));
app.post('/api/generate-proposal', require('./api/generate-proposal'));

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
