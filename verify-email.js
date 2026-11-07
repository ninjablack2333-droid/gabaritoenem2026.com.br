const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const pdf = path.join(__dirname, 'assets', 'gabarito-enem-2026.pdf');
const envFile = path.join(__dirname, '.env');
const env = {};

if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    env[key] = value;
  }
}

env.GMAIL_USER = String(env.GMAIL_USER || '').trim();
env.GMAIL_APP_PASSWORD = String(env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

console.log('GMAIL_USER_SET:', !!env.GMAIL_USER);
console.log('GMAIL_PASSWORD_SET:', !!env.GMAIL_APP_PASSWORD);
console.log('PDF_EXISTS:', fs.existsSync(pdf));

if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD || !fs.existsSync(pdf)) {
  console.log('EMAIL_TEST_SKIPPED: missing Gmail config or PDF.');
  process.exit(0);
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: env.GMAIL_USER,
    pass: env.GMAIL_APP_PASSWORD,
  },
});

transporter.sendMail({
  from: '"Gabarito Enem 2026" <' + env.GMAIL_USER + '>',
  to: env.GMAIL_USER,
  subject: 'Teste de envio do PDF',
  text: 'Teste de envio do PDF anexado.',
  attachments: [{
    filename: 'gabarito-enem-2026.pdf',
    path: pdf,
    contentType: 'application/pdf',
  }],
}).then((info) => {
  console.log('EMAIL_SENT:', true, 'MESSAGE_ID:', info.messageId);
}).catch((err) => {
  console.error('EMAIL_SENT:', false, 'ERROR:', err.message);
  process.exitCode = 1;
});
