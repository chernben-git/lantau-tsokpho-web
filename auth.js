/**
 * 咱兜的台語 — 頁面密碼保護
 * auth.js v1.0
 * 劍橋分析股份有限公司
 */
(function () {
  const PASSWORD = 'taigi1968-2026';
  const KEY = 'taigi_auth';
  const EXPIRY_HOURS = 24; // 24小時內不用重新輸入

  function isAuthed() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (!data.token || !data.expiry) return false;
      if (Date.now() > data.expiry) { localStorage.removeItem(KEY); return false; }
      return data.token === btoa(PASSWORD);
    } catch (e) { return false; }
  }

  function saveAuth() {
    localStorage.setItem(KEY, JSON.stringify({
      token: btoa(PASSWORD),
      expiry: Date.now() + EXPIRY_HOURS * 60 * 60 * 1000
    }));
  }

  function showPrompt() {
    // 遮罩
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;background:#1a1208;
      display:flex;align-items:center;justify-content:center;
      z-index:99999;font-family:'Noto Sans TC',sans-serif;
    `;

    overlay.innerHTML = `
      <div style="background:#faf6ef;border-radius:14px;padding:2rem 2rem 1.6rem;max-width:340px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.4);">
        <div style="font-size:0.65rem;letter-spacing:0.25em;color:#c49a3a;margin-bottom:0.5rem;">文化部 培育台語家庭計畫</div>
        <div style="font-family:'Noto Serif TC',serif;font-size:1.3rem;font-weight:900;color:#1a1208;margin-bottom:0.3rem;">咱兜的台語</div>
        <div style="font-size:0.8rem;color:#7a6e60;margin-bottom:1.4rem;">請輸入活動密碼</div>
        <input id="auth-input" type="password" placeholder="輸入密碼…"
          style="width:100%;padding:0.65rem 0.9rem;border:1.5px solid #d4c9b8;border-radius:8px;
          font-size:0.9rem;font-family:'Noto Sans TC',sans-serif;outline:none;
          text-align:center;letter-spacing:0.1em;background:#f0e8d8;color:#1a1208;margin-bottom:0.8rem;"
        />
        <div id="auth-error" style="font-size:0.75rem;color:#c84b2f;margin-bottom:0.6rem;display:none;">密碼錯誤，請再試一次</div>
        <button id="auth-btn"
          style="width:100%;padding:0.7rem;background:#2f6b4b;color:white;border:none;border-radius:8px;
          font-size:0.88rem;font-family:'Noto Sans TC',sans-serif;font-weight:500;cursor:pointer;">
          進入
        </button>
        <div style="font-size:0.65rem;color:#b0a898;margin-top:1rem;">台語是咱的母語，咱來保護伊</div>
      </div>
    `;

    document.body.appendChild(overlay);
    // 隱藏主體內容
    document.body.style.overflow = 'hidden';

    const input = document.getElementById('auth-input');
    const btn = document.getElementById('auth-btn');
    const err = document.getElementById('auth-error');

    input.focus();

    function tryAuth() {
      if (input.value === PASSWORD) {
        saveAuth();
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s';
        setTimeout(() => { overlay.remove(); document.body.style.overflow = ''; }, 300);
      } else {
        err.style.display = 'block';
        input.value = '';
        input.style.borderColor = '#c84b2f';
        input.focus();
        setTimeout(() => { input.style.borderColor = '#d4c9b8'; }, 1500);
      }
    }

    btn.addEventListener('click', tryAuth);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') tryAuth(); });
  }

  // 主邏輯
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { if (!isAuthed()) showPrompt(); });
  } else {
    if (!isAuthed()) showPrompt();
  }
})();
