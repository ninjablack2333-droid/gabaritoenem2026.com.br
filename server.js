const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT) || 3000;

// ========== LOAD .ENV ==========
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const entries = {};
  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const sep = trimmed.indexOf('=');
    if (sep === -1) return;
    let key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  });
  return entries;
}

const envLocal = loadEnvFile(path.join(__dirname, '.env'));
const envCwd = loadEnvFile(path.join(process.cwd(), '.env'));
const env = { ...envCwd, ...envLocal };

// ========== SIGILO CONFIG ==========
const SIGILO_CHECKOUT_ENDPOINT = process.env.SIGILO_CHECKOUT_ENDPOINT || env.SIGILO_CHECKOUT_ENDPOINT ||
  'https://app.sigilopay.com.br/api/v1/gateway/pix/receive';
const SIGILO_CLIENT_ID = process.env.SIGILO_CLIENT_ID || env.SIGILO_CLIENT_ID || '';
const SIGILO_CLIENT_SECRET = process.env.SIGILO_CLIENT_SECRET || env.SIGILO_CLIENT_SECRET || '';
const SIGILO_TIMEOUT_MS = Number(process.env.SIGILO_TIMEOUT_MS || env.SIGILO_TIMEOUT_MS || 10000);
const SIGILO_WEBHOOK_URL = process.env.SIGILO_WEBHOOK_URL || env.SIGILO_WEBHOOK_URL || '';

const SYNCPAY_API_URL = (process.env.SYNCPAY_API_URL || env.SYNCPAY_API_URL || 'https://api.syncpayments.com.br').replace(/\/$/, '');
const SYNCPAY_CLIENT_ID = process.env.SYNCPAY_CLIENT_ID || env.SYNCPAY_CLIENT_ID || '';
const SYNCPAY_CLIENT_SECRET = process.env.SYNCPAY_CLIENT_SECRET || env.SYNCPAY_CLIENT_SECRET || '';
const SYNCPAY_TIMEOUT_MS = Number(process.env.SYNCPAY_TIMEOUT_MS || env.SYNCPAY_TIMEOUT_MS || 15000);
const SYNCPAY_WEBHOOK_URL = process.env.SYNCPAY_WEBHOOK_URL || env.SYNCPAY_WEBHOOK_URL || '';
const GMAIL_USER = (process.env.GMAIL_USER || env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const PDF_PATH = path.join(__dirname, 'assets', 'gabarito-enem-2026.pdf');

// ========== LOG DE DIAGNÓSTICO ==========
console.log('🔐 Config:');
console.log(`   Sigilo endpoint: ${SIGILO_CHECKOUT_ENDPOINT}`);
console.log(`   Sigilo Client ID: ${SIGILO_CLIENT_ID ? SIGILO_CLIENT_ID.slice(0, 15) + '...' : '❌ NÃO DEFINIDO'}`);
console.log(`   Sigilo Client Secret: ${SIGILO_CLIENT_SECRET ? '✅ configurado (' + SIGILO_CLIENT_SECRET.length + ' chars)' : '❌ NÃO DEFINIDO'}`);
console.log(`   Sigilo webhook: ${SIGILO_WEBHOOK_URL || '⚠️  não definido (callbackUrl será omitido)'}`);
console.log(`   SyncPay API: ${SYNCPAY_API_URL}`);
console.log(`   SyncPay Client ID: ${SYNCPAY_CLIENT_ID ? SYNCPAY_CLIENT_ID.slice(0, 15) + '...' : '❌ NÃO DEFINIDO'}`);
console.log(`   SyncPay Client Secret: ${SYNCPAY_CLIENT_SECRET ? '✅ configurado (' + SYNCPAY_CLIENT_SECRET.length + ' chars)' : '❌ NÃO DEFINIDO'}`);
console.log(`   SyncPay webhook: ${SYNCPAY_WEBHOOK_URL || '⚠️  não definido'}`);
console.log(`   Env file em: ${path.join(__dirname, '.env')}`);
console.log(`   Env file existe: ${fs.existsSync(path.join(__dirname, '.env')) ? '✅ SIM' : '❌ NÃO'}`);
console.log('');

// ========== HELPERS ==========
function buildSigiloHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-public-key': SIGILO_CLIENT_ID,
    'x-secret-key': SIGILO_CLIENT_SECRET,
  };
}

function extractPaymentCode(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.pix?.code) return payload.pix.code;
  return payload.payment_code || payload.paymentCode || payload.qr || '';
}

function extractQrImage(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.pix?.image) return payload.pix.image;
  if (payload.pix?.base64) return payload.pix.base64;
  return payload.qr_image || payload.qrImage || '';
}

function extractCheckoutUrl(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.order?.url) return payload.order.url;
  return payload.checkoutUrl || payload.checkout_url || payload.url || '';
}

function doJsonRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const requestOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 15000,
    };

    const transport = urlObj.protocol === 'https:' ? https : http;
    const req = transport.request(urlObj, requestOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed = body;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          parsed = body;
        }
        resolve({
          statusCode: res.statusCode || 500,
          data: parsed,
        });
      });
    });

    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function getSyncPayAccessToken() {
  if (!SYNCPAY_CLIENT_ID || !SYNCPAY_CLIENT_SECRET) {
    throw new Error('SyncPay client_id/client_secret não configurados.');
  }

  const response = await doJsonRequest(`${SYNCPAY_API_URL}/api/partner/v1/auth-token`, {
    method: 'POST',
    timeout: SYNCPAY_TIMEOUT_MS,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: SYNCPAY_CLIENT_ID,
      client_secret: SYNCPAY_CLIENT_SECRET,
    }),
  });

  if (response.statusCode !== 200 || !response.data || !response.data.access_token) {
    const detail = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
    throw new Error(`SyncPay auth falhou (${response.statusCode}): ${detail}`);
  }

  return response.data.access_token;
}

async function createSyncPayCashin({ amount, customer, description = 'Pagamento via Gabarito Enem 2026' }) {
  const accessToken = await getSyncPayAccessToken();
  const payload = {
    amount: Number(amount),
    description,
    webhook_url: SYNCPAY_WEBHOOK_URL || `${process.env.APP_URL || 'https://ggcheckout.app'}/api/webhook/syncpay`,
    client: {
      name: String(customer.name || 'Cliente'),
      document: String(customer.document || '52998224725').replace(/\D/g, '').slice(0, 11),
      email: String(customer.email || 'contato@exemplo.com'),
      phone: String(customer.phone || '11999999999').replace(/\D/g, '').slice(0, 11),
    },
  };

  const response = await doJsonRequest(`${SYNCPAY_API_URL}/api/partner/v1/cash-in`, {
    method: 'POST',
    timeout: SYNCPAY_TIMEOUT_MS,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const detail = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
    throw new Error(`SyncPay cash-in falhou (${response.statusCode}): ${detail}`);
  }

  return {
    success: true,
    message: response.data?.message || 'Cashin request successfully submitted',
    pix_code: response.data?.pix_code || '',
    identifier: response.data?.identifier || '',
    data: response.data || {},
  };
}

async function sendAccessEmail({ to, name }) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.log('⚠️  Gmail não configurado. Defina GMAIL_USER e GMAIL_APP_PASSWORD no .env');
    return { ok: false, reason: 'missing_gmail_credentials' };
  }

  if (!fs.existsSync(PDF_PATH)) {
    console.log(`⚠️  PDF não encontrado em: ${PDF_PATH}`);
    return { ok: false, reason: 'pdf_not_found' };
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });

  const mail = {
    from: `"Gabarito Enem 2026" <${GMAIL_USER}>`,
    to,
    subject: 'Seu acesso ao Gabarito Enem 2026 foi liberado',
    text: `Olá ${name},\n\nSeu pagamento foi confirmado e seu material já está disponível.\n\nAnexamos o PDF do material em formato de acesso imediato.\n\nAtenciosamente,\nGabarito Enem 2026`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
        <h2 style="margin-bottom: 12px;">Acesso confirmado</h2>
        <p>Olá <strong>${name}</strong>,</p>
        <p>Seu pagamento foi confirmado e seu material já está liberado.</p>
        <p>Em anexo você encontra o PDF com o acesso ao Gabarito Enem 2026.</p>
        <p style="margin-top: 16px;">Obrigado,<br>Gabarito Enem 2026</p>
      </div>
    `,
    attachments: [{
      filename: 'gabarito-enem-2026.pdf',
      path: PDF_PATH,
      contentType: 'application/pdf',
    }],
  };

  try {
    const info = await transporter.sendMail(mail);
    console.log(`✅ E-mail enviado para ${to} | MessageId: ${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Falha ao enviar e-mail:', error.message);
    return { ok: false, reason: error.message };
  }
}

// ========== SERVIDOR ==========
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  console.log(`\n📨 ${req.method} ${pathname}`);

  // ============ ROTA: CHECKOUT ============
  if (pathname === '/api/checkout' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json');

    const collectBody = () => new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });

    try {
      const bodyText = await collectBody();
      if (!bodyText) {
        res.writeHead(400);
        return res.end(JSON.stringify({ success: false, message: 'Corpo vazio' }));
      }

      let requestData;
      try {
        requestData = JSON.parse(bodyText.replace(/^[\uFEFF\u200B-\u200F]+/, ''));
      } catch {
        res.writeHead(400);
        return res.end(JSON.stringify({ success: false, message: 'JSON inválido' }));
      }

      const { customer, product } = requestData;

      if (!customer || !customer.name || !customer.email) {
        res.writeHead(400);
        return res.end(JSON.stringify({ success: false, message: 'Nome e e-mail são obrigatórios' }));
      }
      if (!product || !product.price) {
        res.writeHead(400);
        return res.end(JSON.stringify({ success: false, message: 'Produto inválido' }));
      }

      // ===== PAYLOAD SYNC PAY =====
      const amount = Number(product.price);
      const description = `${product.name || 'Gabarito Enem 2026'} - ${customer.name}`;

      console.log(`   🔗 Enviando para: ${SYNCPAY_API_URL}`);
      console.log(`   💰 Valor: R$ ${amount}`);
      console.log(`   👤 Cliente: ${customer.name} <${customer.email}>`);

      const syncPayResult = await createSyncPayCashin({
        amount,
        customer: {
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          document: customer.document,
        },
        description,
      });

      const statusCode = 200;
      const normalized = {
        success: true,
        statusCode,
        gateway: 'syncpay',
        checkout_url: '',
        payment_code: syncPayResult.pix_code,
        qr_image: '',
        message: syncPayResult.message,
        transaction_id: syncPayResult.identifier,
        data: syncPayResult.data,
      };

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(normalized));

    } catch (error) {
      console.error('❌ Erro:', error.message);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, message: 'Erro interno: ' + error.message }));
    }
    return;
  }

  // ============ WEBHOOK ============
  if ((pathname === '/api/webhook/syncpay' || pathname === '/api/webhook/sigilopay') && req.method === 'POST') {
    const collectBody = () => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
    const bodyText = await collectBody();
    let payload = bodyText;
    try { payload = JSON.parse(bodyText); } catch {}

    const eventName = payload.event || payload.status || payload.type || 'unknown';
    console.log('\n🔔 Webhook recebido!');
    console.log('   Evento:', eventName);
    console.log('   Payload:', JSON.stringify(payload).substring(0, 500));

    const clientEmail = payload.client?.email || payload.client?.email_address || payload.email || '';
    const clientName = payload.client?.name || payload.name || 'Cliente';
    const amount = payload.transaction?.amount || payload.amount || null;
    const isPaid =
      payload.event === 'TRANSACTION_PAID' ||
      payload.status === 'PAID' ||
      payload.status === 'paid' ||
      payload.status === 'confirmed';

    if (isPaid && clientEmail) {
      console.log('   ✅ PAGAMENTO CONFIRMADO! Liberar acesso para:', clientEmail);
      const emailResult = await sendAccessEmail({
        to: clientEmail,
        name: clientName,
      });
      console.log('   📧 Resultado do envio:', emailResult);
    }

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ received: true, event: eventName, amount }));
    return;
  }

  // ============ HEALTH ============
  if (pathname === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    return res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  // ============ STATIC FILES ============
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(path.normalize(__dirname))) {
    res.writeHead(403);
    return res.end('Acesso negado');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Arquivo não encontrado' }));
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`${'='.repeat(50)}`);
  console.log(`🚀 Servidor: http://localhost:${PORT}`);
  console.log(`${'='.repeat(50)}\n`);
});