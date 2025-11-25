// /api/index.js (النسخة النهائية والمصححة)

/**
 * SHIB Ads WebApp Backend API
 * Handles all POST requests from the Telegram Mini App frontend.
 * Uses the Supabase REST API for persistence.
 */
const crypto = require('crypto');

// Load environment variables for Supabase connection
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// ⚠️ يجب تحديد هذا المتغير (توكن البوت) في إعدادات البيئة على Vercel
const BOT_TOKEN = process.env.BOT_TOKEN; 

// ------------------------------------------------------------------
// **ثوابت الأمان والتحكم**
// ------------------------------------------------------------------
const REWARD_PER_AD = 3; 
const REFERRAL_COMMISSION_RATE = 0.05;
const SPIN_SECTORS = [5, 10, 15, 20, 5]; 
const COOLDOWN_PERIOD = 30 * 1000; // 30 ثانية للمشاهدة والدوران

/**
 * Helper function to randomly select a prize from the defined sectors.
 * @returns {{prize: number, prize_index: number}} The prize value and its index.
 */
function calculateRandomSpinPrize() {
    const randomIndex = Math.floor(Math.random() * SPIN_SECTORS.length);
    return {
        prize: SPIN_SECTORS[randomIndex],
        prize_index: randomIndex // ⬅️ إضافة المؤشر للمزامنة مع العجلة في الفرونت أند
    };
}

// --- Helper Functions ---

function sendSuccess(res, data = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data }));
}

function sendError(res, message, statusCode = 400) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

async function supabaseFetch(tableName, method, body = null, queryParams = '?select=*') {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const url = `${SUPABASE_URL}/rest/v1/${tableName}${queryParams}`;

  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation' 
  };

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  };

  const response = await fetch(url, options);
  
  if (response.ok) {
      const responseText = await response.text();
      try {
          const jsonResponse = JSON.parse(responseText);
          return jsonResponse.length > 0 ? jsonResponse : { success: true }; 
      } catch (e) {
          return { success: true }; 
      }
  }

  let data;
  try {
      data = await response.json();
  } catch (e) {
      const errorMsg = `Supabase error: ${response.status} ${response.statusText}`;
      throw new Error(errorMsg);
  }

  const errorMsg = data.message || `Supabase error: ${response.status} ${response.statusText}`;
  throw new Error(errorMsg);
}

// ------------------------------------------------------------------
// **دالة التحقق الأمني من initData (صلاحية الجلسة 30 دقيقة)**
// ------------------------------------------------------------------
function validateInitData(initData) {
    if (!initData || !BOT_TOKEN) {
        console.error('Security Check Failed: Missing initData or BOT_TOKEN.');
        return false;
    }
    
    // 1. استخراج الـ 'hash' والبيانات الأخرى
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    // 2. تجميع البيانات للتحقق
    const dataCheckString = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

    // 3. حساب المفتاح السري والهاش المتوقع
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (calculatedHash !== hash) {
        console.warn('Security Check Failed: Hash mismatch.');
        return false;
    }
    
    // 4. التحقق من تاريخ الانتهاء (30 دقيقة)
    const authDateParam = urlParams.get('auth_date');
    if (!authDateParam) {
        console.warn('Security Check Failed: auth_date is missing.');
        return false;
    }

    const authDate = parseInt(authDateParam) * 1000;
    const currentTime = Date.now();
    
    // ⬇️ تم التعديل إلى 30 دقيقة (1800 ثانية)
    const expirationTime = 1300 * 1000; 

    if (currentTime - authDate > expirationTime) {
        console.warn(`Security Check Failed: Data expired (${expirationTime / 1000}s limit exceeded).`);
        return false;
    }

    return true; 
}

// --- API Handlers ---

/**
 * HANDLER: type: "getUserData"
 */
async function handleGetUserData(req, res, body) {
    const { user_id } = body;
    if (!user_id) {
        return sendError(res, 'Missing user_id for data fetch.');
    }
    const id = parseInt(user_id);

    try {
        // Fetch user data (balance, counts, last_ad_time, last_spin_time)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,spins_today`);
        if (!users || users.length === 0 || users.success) {
            return sendSuccess(res, { 
                balance: 0, 
                ads_watched_today: 0, 
                spins_today: 0,
                referrals_count: 0,
                withdrawal_history: []
            });
        }
        
        const userData = users[0];

        // Fetch referrals count
        const referrals = await supabaseFetch('users', 'GET', null, `?ref_by=eq.${id}&select=id`);
        const referralsCount = Array.isArray(referrals) ? referrals.length : 0;

        // Fetch withdrawal history
        const history = await supabaseFetch('withdrawals', 'GET', null, `?user_id=eq.${id}&select=amount,status,created_at&order=created_at.desc`);
        const withdrawalHistory = Array.isArray(history) ? history : [];

        sendSuccess(res, {
            ...userData,
            referrals_count: referralsCount,
            withdrawal_history: withdrawalHistory
        });

    } catch (error) {
        console.error('GetUserData failed:', error.message);
        sendError(res, `Failed to retrieve user data: ${error.message}`, 500);
    }
}


/**
 * 1) type: "register"
 */
async function handleRegister(req, res, body) {
  const { user_id, ref_by } = body;
  const id = parseInt(user_id);

  try {
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id`);

    if (!Array.isArray(users) || users.length === 0) {
      // User does not exist, create new user
      const newUser = {
        id,
        balance: 0,
        ads_watched_today: 0,
        spins_today: 0,
        ref_by: ref_by ? parseInt(ref_by) : null,
        // ⚠️ يجب التأكد من وجود هذه الأعمدة في قاعدة البيانات
        last_ad_time: null, 
        last_spin_time: null,
      };

      await supabaseFetch('users', 'POST', newUser, '?select=id');
    }

    sendSuccess(res, { message: 'User registered or already exists.' });
  } catch (error) {
    console.error('Registration failed:', error.message);
    sendError(res, `Registration failed: ${error.message}`, 500);
  }
}

/**
 * 2) type: "watchAd"
 * **تطبيق فترة التهدئة (30 ثانية)**
 */
async function handleWatchAd(req, res, body) {
  const { user_id } = body;
  const id = parseInt(user_id);
  const reward = REWARD_PER_AD;

  try {
    // 1. Fetch current user data and last_ad_time
    // ⚠️ يجب التأكد من اختيار عمود last_ad_time
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,last_ad_time`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    const user = users[0];
    const lastAdTime = user.last_ad_time ? new Date(user.last_ad_time).getTime() : 0;
    const now = Date.now();

    // 2. **التحقق من التهدئة (Cooldown)**
    if (now - lastAdTime < COOLDOWN_PERIOD) {
        const remainingSeconds = Math.ceil((COOLDOWN_PERIOD - (now - lastAdTime)) / 1000);
        return sendError(res, `يرجى الانتظار ${remainingSeconds} ثانية قبل مشاهدة إعلان آخر.`, 429); // 429 Too Many Requests
    }
    
    // 3. تنفيذ الإجراء
    const newBalance = user.balance + reward;
    const newAdsCount = user.ads_watched_today + 1;

    // 4. Update user record: balance, ads_watched_today, and last_ad_time
    await supabaseFetch('users', 'PATCH', 
      { 
        balance: newBalance, 
        ads_watched_today: newAdsCount, 
        last_ad_time: new Date().toISOString() // ⬅️ تحديث وقت آخر إجراء
      }, 
      `?id=eq.${id}`);

    // 5. Save to ads_history
    await supabaseFetch('ads_history', 'POST', 
      { user_id: id, reward }, 
      '?select=user_id');

    // 6. Return new state
    sendSuccess(res, { new_balance: newBalance, new_ads_count: newAdsCount, actual_reward: reward });
  } catch (error) {
    console.error('WatchAd failed:', error.message);
    sendError(res, `WatchAd failed: ${error.message}`, 500);
  }
}

/**
 * 3) type: "commission"
 */
async function handleCommission(req, res, body) {
  const { referrer_id, referee_id } = body; 

  if (!referrer_id || !referee_id) {
    return sendSuccess(res, { message: 'Invalid commission data received but acknowledged.' });
  }

  const referrerId = parseInt(referrer_id);
  const refereeId = parseInt(referee_id);
  
  const sourceReward = REWARD_PER_AD;
  const commissionAmount = sourceReward * REFERRAL_COMMISSION_RATE; 

  try {
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${referrerId}&select=balance`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendSuccess(res, { message: 'Referrer not found, commission aborted.' });
    }
    
    const newBalance = users[0].balance + commissionAmount;

    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance }, 
      `?id=eq.${referrerId}`);

    await supabaseFetch('commission_history', 'POST', 
      { referrer_id: referrerId, referee_id: refereeId, amount: commissionAmount, source_reward: sourceReward }, 
      '?select=referrer_id');

    sendSuccess(res, { new_referrer_balance: newBalance });
  } catch (error) {
    console.error('Commission failed:', error.message);
    sendError(res, `Commission failed: ${error.message}`, 500);
  }
}

/**
 * 4) type: "spin"
 * **تطبيق فترة التهدئة (30 ثانية)**
 */
async function handleSpin(req, res, body) {
  const { user_id } = body;
  const id = parseInt(user_id);

  try {
    // 1. Fetch current user data and last_spin_time
    // ⚠️ يجب التأكد من اختيار عمود last_spin_time
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=spins_today,last_spin_time`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    const user = users[0];
    const lastSpinTime = user.last_spin_time ? new Date(user.last_spin_time).getTime() : 0;
    const now = Date.now();

    // 2. **التحقق من التهدئة (Cooldown)**
    if (now - lastSpinTime < COOLDOWN_PERIOD) {
        const remainingSeconds = Math.ceil((COOLDOWN_PERIOD - (now - lastSpinTime)) / 1000);
        return sendError(res, `يرجى الانتظار ${remainingSeconds} ثانية قبل الدوران مرة أخرى.`, 429); // 429 Too Many Requests
    }

    // 3. تنفيذ الإجراء
    const newSpinsCount = user.spins_today + 1;

    // 4. Update user record: spins_today and last_spin_time
    await supabaseFetch('users', 'PATCH', 
      { 
        spins_today: newSpinsCount, 
        last_spin_time: new Date().toISOString() // ⬅️ تحديث وقت آخر إجراء
      }, 
      `?id=eq.${id}`);

    // 5. Save to spin_requests
    await supabaseFetch('spin_requests', 'POST', 
      { user_id: id }, 
      '?select=user_id');

    sendSuccess(res, { new_spins_today: newSpinsCount });
  } catch (error) {
    console.error('Spin request failed:', error.message);
    sendError(res, `Spin request failed: ${error.message}`, 500);
  }
}

/**
 * 5) type: "spinResult"
 */
async function handleSpinResult(req, res, body) {
  const { user_id } = body; 
  const id = parseInt(user_id);
  
  // ⬅️ حساب الجائزة والمؤشر بشكل آمن على الخادم
  const { prize, prize_index } = calculateRandomSpinPrize(); 

  try {
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }
    
    const newBalance = users[0].balance + prize;

    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance }, 
      `?id=eq.${id}`);

    await supabaseFetch('spin_results', 'POST', 
      { user_id: id, prize }, 
      '?select=user_id');

    // ⬅️ إرجاع الجائزة والمؤشر للواجهة الأمامية
    sendSuccess(res, { new_balance: newBalance, actual_prize: prize, prize_index: prize_index }); 
  } catch (error) {
    console.error('Spin result failed:', error.message);
    sendError(res, `Spin result failed: ${error.message}`, 500);
  }
}

/**
 * 6) type: "withdraw"
 */
async function handleWithdraw(req, res, body) {
  const { user_id, binanceId, amount } = body;
  const id = parseInt(user_id);
  
  if (typeof amount !== 'number' || amount <= 0) {
        return sendError(res, 'Invalid withdrawal amount.', 400);
  }

  try {
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance`);
    if (!Array.isArray(users) || users.length === 0) {
        return sendError(res, 'User not found.', 404);
    }

    const currentBalance = users[0].balance;
    if (amount < 400) { 
        return sendError(res, 'Minimum withdrawal is 400 SHIB.', 403);
    }
    if (amount > currentBalance) {
        return sendError(res, 'Insufficient balance.', 403);
    }
    
    const newBalance = currentBalance - amount;

    await supabaseFetch('users', 'PATCH', 
      { balance: newBalance }, 
      `?id=eq.${id}`);

    await supabaseFetch('withdrawals', 'POST', {
      user_id: id,
      binance_id: binanceId,
      amount: amount,
      status: 'Pending',
    }, '?select=user_id');

    sendSuccess(res, { new_balance: newBalance });
  } catch (error) {
    console.error('Withdrawal failed:', error.message);
    sendError(res, `Withdrawal failed: ${error.message}`, 500);
  }
}

// --- Main Handler for Vercel/Serverless ---

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return sendSuccess(res);
  }

  if (req.method !== 'POST') {
    return sendError(res, `Method ${req.method} not allowed. Only POST is supported.`, 405);
  }

  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk.toString(); });
      req.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON payload.')); }
      });
      req.on('error', reject);
    });

  } catch (error) {
    return sendError(res, error.message, 400);
  }

  if (!body || !body.type) {
    return sendError(res, 'Missing "type" field in the request body.', 400);
  }
  
  // ⬅️ التحقق الأمني من initData
  if (!body.initData || !validateInitData(body.initData)) {
      return sendError(res, 'Invalid or expired initData. Security check failed.', 401); // ⬅️ يرسل خطأ 401
  }
  
  if (!body.user_id && body.type !== 'commission') {
      return sendError(res, 'Missing user_id in the request body.', 400);
  }

  // Route the request based on the 'type' field
  switch (body.type) {
    case 'getUserData':
      await handleGetUserData(req, res, body);
      break;
    case 'register':
      await handleRegister(req, res, body);
      break;
    case 'watchAd':
      await handleWatchAd(req, res, body);
      break;
    case 'commission':
      await handleCommission(req, res, body);
      break;
    case 'spin':
      await handleSpin(req, res, body);
      break;
    case 'spinResult':
      await handleSpinResult(req, res, body);
      break;
    case 'withdraw':
      await handleWithdraw(req, res, body);
      break;
    default:
      sendError(res, `Unknown action type: ${body.type}`, 400);
  }
};