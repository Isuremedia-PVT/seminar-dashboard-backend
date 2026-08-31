require('dotenv').config();
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;

const ng = spawn('ngrok', ['http', String(PORT)], { stdio: 'inherit' });

ng.on('error', () => {
  console.error('\nngrok not found. Install it:');
  console.error('  1. Download from https://ngrok.com/download');
  console.error('  2. Run: ngrok config add-authtoken <your_token>');
  console.error('  3. Then retry: npm run tunnel\n');
});

ng.on('close', code => { if (code !== 0 && code !== null) process.exit(code); });
