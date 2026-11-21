const config = require('../config/config');
const db = require('../database/database');
const { getRaidStatus } = require('../security/antiRaid');
const { getAdaptiveState } = require('../security/adaptiveSecurity');

const RULES_80 = [
  '01. Kanal silme eşik ve patlama tespiti',
  '02. Kanal oluşturma eşik ve spam önleme',
  '03. Kanal izin (overwrite) manipülasyon tespiti',
  '04. Rol silme eşik ve rollback tetikleme',
  '05. Rol oluşturma eşik kontrolü',
  '06. Rol yetki yükseltme (roleUpdate) takibi',
  '07. Tehlikeli rol atama izolasyonu',
  '08. Sunucu ayar/isim/ikon değişikliği takibi',
  '09. Saldırgan tehlikeli rollerini anında sıyırma',
  '10. Saldırı patlamasında cooldown/spam engeli',
  '11. Kısa pencerede toplu üye giriş tespiti',
  '12. Raid kalkanının süreli aktivasyonu ve kapanışı',
  '13. Yeni hesap yaşı (minAccountAgeDays) analizi',
  '14. Raid anında yeni hesapları karantinaya alma',
  '15. Ses kanallarına ani toplu giriş tespiti',
  '16. Yeni hesap risk puanlaması',
  '17. Giriş/çıkış hareketliliği takibi',
  '18. Kara liste üyesinin girişte yeniden banlanması',
  '19. Yetkisiz unban işlemine anında geri ban',
  '20. Raid sırasında koruma durumu raporlama',
  '21. Sahte Nitro / hediye / airdrop taraması',
  '22. Punycode (xn--) ve taklit domain tespiti',
  '23. İzinsiz Discord davet bağlantısı engeli',
  '24. Kısaltılmış bağlantı (bit.ly, tinyurl vb.) kontrolü',
  '25. Küfür / hakaret kalıp filtresi',
  '26. Toplu kullanıcı etiketleme (Mass Mention) sınırı',
  '27. Aşırı emoji ve sticker spam tespiti',
  '28. Aşırı büyük harf (Caps Lock) oranı kontrolü',
  '29. Mesaj flood ve tekrarlayan içerik tespiti',
  '30. Risk skoruna göre kademeli susturma süresi',
  '31. Yetkisiz webhook oluşturma tespiti',
  '32. Yetkisiz webhook anında silme',
  '33. Yetkisiz bot ekleme tespiti',
  '34. Yetkisiz bot atma ve ekleyene müdahale',
  '35. Emoji silme denetim ve log kaydı',
  '36. Sticker silme denetim ve log kaydı',
  '37. Thread silme denetim ve log kaydı',
  '38. Scheduled Event oluşturma/silme kaydı',
  '39. Toplu mesaj silme (messageDeleteBulk) kaydı',
  '40. AuditLog zaman ve hedef eşleştirmesi',
  '41. 0-100 sınırlandırılmış merkezî risk skoru',
  '42. Risk geçmişi (risk_history) sebep ve delta kaydı',
  '43. Düşük risk puanlarının kademeli erimesi',
  '44. Yüksek riskte susturma süresini artırma',
  '45. Moderatör dakikalık yaptırım hızı takibi',
  '46. Moderatör hız eşiği aşımında uyarı',
  '47. Kullanıcı sicil/vaka/risk sorgulama',
  '48. Kullanıcı profil ve hesap yaşı özeti',
  '49. Vaka türüne göre dağılım analitiği',
  '50. IP / Ağ izolasyon kayıt ve giriş engeli',
  '51. Karantina öncesi rolleri SQLite yedekleme',
  '52. Karantinada yönetilebilir rolleri sıyırma',
  '53. Süreli karantina (expires_at) desteği',
  '54. Süresi dolan karantinayı otomatik kaldırma',
  '55. Karantinadan çıkarırken rolleri geri yükleme',
  '56. Artan sayaçlı vaka numarası (CASE-XXXX)',
  '57. Vaka silme ve bütünlük kontrolü',
  '58. Kullanıcı itiraz kaydı (APL-XXXX)',
  '59. İtiraz onaylama/reddetme ve not ekleme',
  '60. İtiraz ve vaka olaylarının log aktarımı',
  '61. Kanal yapısının snapshot alınması',
  '62. Rol yapısının snapshot alınması',
  '63. Silinen kanalın otomatik geri oluşturulması',
  '64. Silinen rolün otomatik geri oluşturulması',
  '65. SQLite veritabanının db.backup() yedeği',
  '66. Eski yedeklerin otomatik temizlenmesi (son 10)',
  '67. 30 dakikada bir periyodik snapshot/yedek',
  '68. Manuel yedek alma komutu (/yedek-al)',
  '69. Tek kanal kilitleme/açma (/kilit)',
  '70. Tüm metin kanallarını toplu kilitleme (/sunucu-kilit)',
  '71. SQLite guild_config canlı ayar saklama',
  '72. Anti-Nuke eşiğini canlı değiştirme',
  '73. Anti-Raid eşiğini canlı değiştirme',
  '74. AutoMod durumunu canlı açma/kapatma',
  '75. Ayarları JSON dışa/içe aktarma',
  '76. Otomatik güvenlik denetimi (/guvenlik-denetimi)',
  '77. Güvenlik simülasyon testi (/guvenlik-test)',
  '78. Gerçek /health durum kontrol ucu',
  '79. Bot içi özet panel (/panel)',
  '80. Özel Web Kontrol Paneli (/dashboard & API)',
];

function isAuthorized(req) {
  if (!config.dashboardToken) return true;
  const authHeader = req.headers.authorization || '';
  if (authHeader === `Bearer ${config.dashboardToken}`) return true;
  const customHeader = req.headers['x-dashboard-token'] || '';
  if (customHeader === config.dashboardToken) return true;
  try {
    const urlObj = new URL(req.url, `http://localhost:${config.port}`);
    return urlObj.searchParams.get('token') === config.dashboardToken;
  } catch {
    return false;
  }
}

function getRecentBlacklist(limit = 25) {
  return db.db.prepare('SELECT * FROM blacklist ORDER BY created_at DESC LIMIT ?').all(limit);
}

function getRecentIpBans(limit = 25) {
  return db.db.prepare('SELECT * FROM ip_bans ORDER BY created_at DESC LIMIT ?').all(limit);
}

function getRecentAppeals(limit = 20) {
  return db.db.prepare('SELECT * FROM appeals ORDER BY seq DESC LIMIT ?').all(limit);
}

function buildOverview(client) {
  const guild = client.guilds.cache.get(config.guildId);
  const raid = getRaidStatus();
  const adaptive = getAdaptiveState();
  const gcfg = db.getGuildConfig();
  return {
    botReady: Boolean(client.isReady() && client.user),
    botTag: client.user?.tag || 'Baslatiliyor',
    pingMs: client.isReady() ? client.ws.ping : null,
    uptimeSec: Math.floor(process.uptime()),
    guildName: guild?.name || config.guildId,
    guildId: config.guildId,
    memberCount: guild?.memberCount || null,
    raid,
    adaptive,
    counts: {
      cases: db.getTotalCases(),
      blacklist: db.countBlacklist(),
      ipBans: db.countIpBans(),
      whitelist: db.listWhitelist().length,
    },
    caseStats: db.getCaseStatsByType(),
    recentCases: db.getRecentCases(40),
    blacklistEntries: getRecentBlacklist(25),
    ipBanEntries: getRecentIpBans(25),
    whitelistEntries: db.listWhitelist().slice(0, 25),
    appealEntries: getRecentAppeals(20),
    config: gcfg,
    rulesCount: RULES_80.length,
    rules: RULES_80,
    timestamp: Date.now(),
  };
}

function renderDashboardHtml(tokenParam = '') {
  const initialToken = JSON.stringify(tokenParam || '');
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SENTINEL SOC OMEGA — 80/80 Güvenlik Kontrol Merkezi</title>
  <style>
    :root {
      --bg: #050811;
      --panel: #0b1120;
      --panel-2: #111a2e;
      --border: #1e293b;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #0ea5e9;
      --accent-2: #38bdf8;
      --danger: #ef4444;
      --ok: #10b981;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, Segoe UI, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      min-height: 100vh;
    }
    .sidebar {
      width: 260px;
      background: var(--panel);
      border-right: 1px solid var(--border);
      padding: 20px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .brand {
      font-weight: 800;
      font-size: 15px;
      padding: 8px 10px 16px;
      border-bottom: 1px solid var(--border);
      color: var(--accent-2);
      letter-spacing: 0.4px;
    }
    .nav-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--muted);
      padding: 10px 12px;
      border-radius: 8px;
      text-align: left;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    }
    .nav-btn:hover { background: var(--panel-2); color: #fff; }
    .nav-btn.active { background: #0ea5e91f; border-color: #0ea5e966; color: var(--accent-2); }
    .main { flex: 1; padding: 24px 28px; overflow-y: auto; }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 22px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .title { font-size: 21px; font-weight: 800; margin: 0; }
    .meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .btn-group { display: flex; flex-wrap: wrap; gap: 8px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 15px;
      margin-bottom: 16px;
    }
    .k { font-size: 12px; color: var(--muted); }
    .v { font-size: 22px; font-weight: 800; margin-top: 6px; color: #f8fafc; }
    .badge-ok { color: var(--ok); }
    .badge-warn { color: var(--danger); }
    .badge-pur { color: var(--purple); }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 16px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      font-size: 13px;
    }
    th { background: var(--panel-2); color: #cbd5e1; font-weight: 700; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    .form-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 12px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    label { font-size: 12px; color: var(--muted); }
    input, select {
      background: var(--bg);
      border: 1px solid #293548;
      color: #f8fafc;
      padding: 8px 11px;
      border-radius: 8px;
      font-size: 13px;
      min-width: 150px;
    }
    button.action {
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 9px 14px;
      border-radius: 8px;
      font-weight: 700;
      cursor: pointer;
      font-size: 13px;
    }
    button.action:hover { background: #0284c7; }
    button.danger { background: var(--danger); }
    button.danger:hover { background: #dc2626; }
    button.secondary { background: var(--panel-2); border: 1px solid var(--border); color: var(--text); }
    .rules-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
      gap: 8px;
    }
    .rule-item {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 12px;
      color: #cbd5e1;
    }
    .auth-box {
      max-width: 420px;
      margin: 70px auto;
      background: var(--panel);
      border: 1px solid var(--border);
      padding: 24px;
      border-radius: 12px;
    }
    @media (max-width: 820px) {
      body { flex-direction: column; }
      .sidebar { width: 100%; height: auto; position: static; flex-direction: row; flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">🛡️ SENTINEL OMEGA • 80/80</div>
    <button class="nav-btn active" data-tab="overview">Genel Bakış</button>
    <button class="nav-btn" data-tab="cases">Vakalar & İtirazlar</button>
    <button class="nav-btn" data-tab="lists">Kara Liste, IP & Whitelist</button>
    <button class="nav-btn" data-tab="settings">Canlı Ayarlar & Kalkanlar</button>
    <button class="nav-btn" data-tab="rules">80 Kural Matrisi</button>
  </aside>

  <main class="main">
    <div id="authScreen" class="auth-box" style="display:none;">
      <h2 style="margin-top:0;">Kontrol Merkezi Girişi</h2>
      <p style="font-size:13px;color:var(--muted);">DASHBOARD_TOKEN değerini girerek oturum aç.</p>
      <div class="field" style="margin-bottom:12px;">
        <label for="tokenInput">Erişim Anahtarı</label>
        <input id="tokenInput" type="password" placeholder="DASHBOARD_TOKEN" />
      </div>
      <button class="action" id="saveTokenBtn">Panele Gir</button>
    </div>

    <div id="appContent">
      <div class="topbar">
        <div>
          <h1 class="title">Güvenlik Kontrol Merkezi</h1>
          <div class="meta" id="metaLine">Bağlanıyor...</div>
        </div>
        <div class="btn-group">
          <button class="action secondary" id="refreshBtn">Yenile</button>
          <button class="action" id="backupBtn">Anlık Yedek Al</button>
        </div>
      </div>

      <section id="tab-overview" class="tab-pane active">
        <div class="grid" id="statCards"></div>
        <div class="card">
          <h3 style="margin-top:0;">Son Güvenlik Vakaları</h3>
          <table>
            <thead>
              <tr><th>Vaka</th><th>Tür</th><th>Hedef</th><th>Sebep</th></tr>
            </thead>
            <tbody id="overviewCases"></tbody>
          </table>
        </div>
      </section>

      <section id="tab-cases" class="tab-pane">
        <div class="grid" id="typeStats"></div>
        <div class="card">
          <h3 style="margin-top:0;">Vaka Arama ve Silme</h3>
          <div class="form-row">
            <div class="field">
              <label for="caseFilter">Vaka veya Hedef Ara</label>
              <input id="caseFilter" type="text" placeholder="CASE-0001, BAN, ID..." />
            </div>
            <div class="field">
              <label for="deleteCaseId">Vaka ID Sil</label>
              <input id="deleteCaseId" type="text" placeholder="CASE-0001" />
            </div>
            <button class="action danger" id="deleteCaseBtn">Vakayı Sil</button>
          </div>
          <div id="caseStatus" style="font-size:13px;color:var(--accent-2);margin-bottom:10px;"></div>
          <table>
            <thead>
              <tr><th>Vaka</th><th>Tür</th><th>Hedef</th><th>Sebep</th></tr>
            </thead>
            <tbody id="allCases"></tbody>
          </table>
        </div>

        <div class="card">
          <h3 style="margin-top:0;">İtiraz Yönetimi (APL-XXXX)</h3>
          <div class="form-row">
            <div class="field">
              <label for="appealIdInput">İtiraz ID</label>
              <input id="appealIdInput" type="text" placeholder="APL-0001" />
            </div>
            <div class="field">
              <label for="appealStatusSel">Karar</label>
              <select id="appealStatusSel">
                <option value="APPROVED">Onayla</option>
                <option value="REJECTED">Reddet</option>
              </select>
            </div>
            <div class="field">
              <label for="appealNoteInput">Not</label>
              <input id="appealNoteInput" type="text" placeholder="İnceleme notu" />
            </div>
            <button class="action" id="reviewAppealBtn">Kararı Uygula</button>
          </div>
          <table>
            <thead>
              <tr><th>ID</th><th>Kullanıcı</th><th>Durum</th><th>Gerekçe</th></tr>
            </thead>
            <tbody id="appealTable"></tbody>
          </table>
        </div>
      </section>

      <section id="tab-lists" class="tab-pane">
        <div class="card">
          <h3 style="margin-top:0;">IP / Ağ İzolasyonu</h3>
          <div class="form-row">
            <div class="field">
              <label for="ipTarget">Kullanıcı ID veya Ağ Etiketi</label>
              <input id="ipTarget" type="text" placeholder="123456789012345678 veya NET-01" />
            </div>
            <div class="field">
              <label for="ipReason">Sebep</label>
              <input id="ipReason" type="text" placeholder="Zararlı aktivite" />
            </div>
            <button class="action danger" id="addIpBtn">İzole Et (IP Ban)</button>
            <button class="action secondary" id="removeIpBtn">İzolasyonu Kaldır</button>
          </div>
          <div id="listStatus" style="font-size:13px;color:var(--accent-2);"></div>
        </div>

        <div class="card">
          <h3 style="margin-top:0;">Güvenli Liste (Whitelist) Yönetimi</h3>
          <div class="form-row">
            <div class="field">
              <label for="wlType">Tür</label>
              <select id="wlType">
                <option value="user">Kullanıcı</option>
                <option value="role">Rol</option>
              </select>
            </div>
            <div class="field">
              <label for="wlId">ID</label>
              <input id="wlId" type="text" placeholder="Kullanıcı veya Rol ID" />
            </div>
            <button class="action" id="addWlBtn">Ekle</button>
            <button class="action secondary" id="removeWlBtn">Çıkar</button>
          </div>
          <table>
            <thead>
              <tr><th>ID</th><th>Tür</th><th>Ekleyen</th></tr>
            </thead>
            <tbody id="wlTable"></tbody>
          </table>
        </div>

        <div class="card">
          <h3 style="margin-top:0;">Aktif IP / Ağ İzolasyonları</h3>
          <table>
            <thead>
              <tr><th>ID</th><th>Kullanıcı</th><th>Ağ Etiketi</th><th>Sebep</th></tr>
            </thead>
            <tbody id="ipTable"></tbody>
          </table>
        </div>

        <div class="card">
          <h3 style="margin-top:0;">Kara Liste Kayıtları</h3>
          <table>
            <thead>
              <tr><th>Kullanıcı ID</th><th>Yetkili</th><th>Sebep</th></tr>
            </thead>
            <tbody id="blTable"></tbody>
          </table>
        </div>
      </section>

      <section id="tab-settings" class="tab-pane">
        <div class="card">
          <h3 style="margin-top:0;">Canlı Eşik & Filtre Ayarları</h3>
          <div class="form-row">
            <div class="field">
              <label for="anThreshold">Anti-Nuke Eşiği (1-20)</label>
              <input id="anThreshold" type="number" min="1" max="20" />
            </div>
            <div class="field">
              <label for="raidThreshold">Raid 10sn Eşiği (2-50)</label>
              <input id="raidThreshold" type="number" min="2" max="50" />
            </div>
            <div class="field">
              <label for="automodState">AutoMod Durumu</label>
              <select id="automodState">
                <option value="true">Aktif</option>
                <option value="false">Kapalı</option>
              </select>
            </div>
            <button class="action" id="saveSettingsBtn">Ayarları Kaydet</button>
          </div>
          <div class="form-row" style="margin-top:16px;">
            <button class="action danger" id="raidOnBtn">Raid Kalkanını Aç</button>
            <button class="action secondary" id="raidOffBtn">Raid Kalkanını Kapat</button>
          </div>
          <div id="settingsStatus" style="font-size:13px;color:var(--accent-2);"></div>
        </div>
      </section>

      <section id="tab-rules" class="tab-pane">
        <div class="rules-grid" id="rulesList"></div>
      </section>
    </div>
  </main>

  <script>
    const urlToken = ${initialToken};
    let token = urlToken || localStorage.getItem('sec_dash_token') || '';
    if (urlToken) localStorage.setItem('sec_dash_token', urlToken);
    let latestData = null;

    function headers() {
      return token
        ? { 'Content-Type': 'application/json', 'x-dashboard-token': token }
        : { 'Content-Type': 'application/json' };
    }

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      });
    });

    document.getElementById('saveTokenBtn').addEventListener('click', () => {
      token = document.getElementById('tokenInput').value.trim();
      localStorage.setItem('sec_dash_token', token);
      document.getElementById('authScreen').style.display = 'none';
      document.getElementById('appContent').style.display = 'block';
      refresh();
    });

    document.getElementById('refreshBtn').addEventListener('click', refresh);

    document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
      const payload = {
        antiNukeThreshold: Number(document.getElementById('anThreshold').value),
        raidJoinThreshold: Number(document.getElementById('raidThreshold').value),
        autoModEnabled: document.getElementById('automodState').value === 'true',
      };
      const res = await fetch('/api/config', { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
      const data = await res.json();
      document.getElementById('settingsStatus').textContent = res.ok ? 'Ayarlar kaydedildi.' : (data.error || 'Hata');
      refresh();
    });

    document.getElementById('raidOnBtn').addEventListener('click', async () => {
      await fetch('/api/raid', { method: 'POST', headers: headers(), body: JSON.stringify({ active: true }) });
      document.getElementById('settingsStatus').textContent = 'Raid kalkanı aktif edildi.';
      refresh();
    });

    document.getElementById('raidOffBtn').addEventListener('click', async () => {
      await fetch('/api/raid', { method: 'POST', headers: headers(), body: JSON.stringify({ active: false }) });
      document.getElementById('settingsStatus').textContent = 'Raid kalkanı kapatıldı.';
      refresh();
    });

    document.getElementById('addIpBtn').addEventListener('click', async () => {
      const target = document.getElementById('ipTarget').value.trim();
      const reason = document.getElementById('ipReason').value.trim() || 'Panel IP/Ağ izolasyonu';
      if (!target) return;
      const res = await fetch('/api/ipban', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: 'add', target, reason }),
      });
      const data = await res.json();
      document.getElementById('listStatus').textContent = res.ok ? 'İzolasyon eklendi.' : (data.error || 'Hata');
      refresh();
    });

    document.getElementById('removeIpBtn').addEventListener('click', async () => {
      const target = document.getElementById('ipTarget').value.trim();
      if (!target) return;
      const res = await fetch('/api/ipban', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: 'remove', target }),
      });
      const data = await res.json();
      document.getElementById('listStatus').textContent = res.ok ? 'İzolasyon kaldırıldı.' : (data.error || 'Hata');
      refresh();
    });

    document.getElementById('addWlBtn').addEventListener('click', async () => {
      const targetId = document.getElementById('wlId').value.trim();
      const targetType = document.getElementById('wlType').value;
      if (!targetId) return;
      const res = await fetch('/api/whitelist', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: 'add', targetId, targetType }),
      });
      const data = await res.json();
      document.getElementById('listStatus').textContent = res.ok ? 'Güvenli listeye eklendi.' : (data.error || 'Hata');
      refresh();
    });

    document.getElementById('removeWlBtn').addEventListener('click', async () => {
      const targetId = document.getElementById('wlId').value.trim();
      if (!targetId) return;
      const res = await fetch('/api/whitelist', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ action: 'remove', targetId }),
      });
      const data = await res.json();
      document.getElementById('listStatus').textContent = res.ok ? 'Güvenli listeden çıkarıldı.' : (data.error || 'Hata');
      refresh();
    });

    document.getElementById('deleteCaseBtn').addEventListener('click', async () => {
      const caseId = document.getElementById('deleteCaseId').value.trim();
      if (!caseId) return;
      const res = await fetch('/api/case-delete', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ caseId }),
      });
      const data = await res.json();
      document.getElementById('caseStatus').textContent = res.ok ? 'Vaka silindi.' : (data.error || 'Bulunamadı');
      refresh();
    });

    document.getElementById('reviewAppealBtn').addEventListener('click', async () => {
      const appealId = document.getElementById('appealIdInput').value.trim();
      const status = document.getElementById('appealStatusSel').value;
      const note = document.getElementById('appealNoteInput').value.trim();
      if (!appealId) return;
      const res = await fetch('/api/appeal', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ appealId, status, note }),
      });
      const data = await res.json();
      document.getElementById('caseStatus').textContent = res.ok ? 'İtiraz güncellendi.' : (data.error || 'Bulunamadı');
      refresh();
    });

    document.getElementById('backupBtn').addEventListener('click', async () => {
      const res = await fetch('/api/backup', { method: 'POST', headers: headers() });
      const data = await res.json();
      alert(res.ok ? 'Yedek alındı: ' + data.file : (data.error || 'Yedek alınamadı'));
    });

    document.getElementById('caseFilter').addEventListener('input', renderFilteredCases);

    function renderFilteredCases() {
      if (!latestData) return;
      const q = document.getElementById('caseFilter').value.trim().toLowerCase();
      const list = (latestData.recentCases || []).filter(c =>
        !q ||
        String(c.id).toLowerCase().includes(q) ||
        String(c.type).toLowerCase().includes(q) ||
        String(c.target_id).toLowerCase().includes(q) ||
        String(c.reason).toLowerCase().includes(q)
      );
      document.getElementById('allCases').innerHTML = list
        .map(c => '<tr><td>' + c.id + '</td><td>' + c.type + '</td><td>' + c.target_id + '</td><td>' + c.reason + '</td></tr>')
        .join('');
    }

    async function refresh() {
      const res = await fetch('/api/overview', { headers: headers() });
      if (res.status === 401) {
        document.getElementById('authScreen').style.display = 'block';
        document.getElementById('appContent').style.display = 'none';
        return;
      }
      const d = await res.json();
      latestData = d;

      document.getElementById('metaLine').textContent =
        'Sunucu: ' + d.guildName + ' | Bot: ' + d.botTag + ' | Ping: ' + (d.pingMs ?? '-') + 'ms | Kurallar: ' + d.rulesCount + '/80';

      const cards = [
        ['Toplam Vaka', d.counts.cases, ''],
        ['Kara Liste', d.counts.blacklist, ''],
        ['IP / Ağ İzolasyonu', d.counts.ipBans, ''],
        ['Güvenli Liste', d.counts.whitelist, ''],
        ['Raid Kalkanı', d.raid.active ? 'AKTİF' : 'Normal', d.raid.active ? 'badge-warn' : 'badge-ok'],
        ['Adaptif Mod', d.adaptive?.elevated ? 'YÜKSEK' : 'Standart', d.adaptive?.elevated ? 'badge-pur' : 'badge-ok'],
      ];
      document.getElementById('statCards').innerHTML = cards
        .map(([k, v, cls]) => '<div class="card"><div class="k">' + k + '</div><div class="v ' + cls + '">' + v + '</div></div>')
        .join('');

      document.getElementById('overviewCases').innerHTML = (d.recentCases || []).slice(0, 12)
        .map(c => '<tr><td>' + c.id + '</td><td>' + c.type + '</td><td>' + c.target_id + '</td><td>' + c.reason + '</td></tr>')
        .join('');

      renderFilteredCases();

      document.getElementById('typeStats').innerHTML = (d.caseStats || [])
        .map(s => '<div class="card"><div class="k">' + s.type + '</div><div class="v">' + s.cnt + '</div></div>')
        .join('');

      document.getElementById('appealTable').innerHTML = (d.appealEntries || [])
        .map(a => '<tr><td>' + a.id + '</td><td>' + a.user_id + '</td><td>' + a.status + '</td><td>' + a.reason + '</td></tr>')
        .join('');

      document.getElementById('wlTable').innerHTML = (d.whitelistEntries || [])
        .map(w => '<tr><td>' + w.target_id + '</td><td>' + w.target_type + '</td><td>' + w.added_by + '</td></tr>')
        .join('');

      document.getElementById('ipTable').innerHTML = (d.ipBanEntries || [])
        .map(x => '<tr><td>' + x.id + '</td><td>' + (x.user_id || '-') + '</td><td>' + x.network_tag + '</td><td>' + x.reason + '</td></tr>')
        .join('');

      document.getElementById('blTable').innerHTML = (d.blacklistEntries || [])
        .map(x => '<tr><td>' + x.user_id + '</td><td>' + x.banned_by + '</td><td>' + x.reason + '</td></tr>')
        .join('');

      document.getElementById('anThreshold').value = d.config.antiNuke.threshold;
      document.getElementById('raidThreshold').value = d.config.raid.joinThreshold;
      document.getElementById('automodState').value = String(d.config.autoMod.enabled);

      document.getElementById('rulesList').innerHTML = (d.rules || [])
        .map(r => '<div class="rule-item">' + r + '</div>')
        .join('');
    }

    refresh();
    setInterval(refresh, 15000);
  </script>
</body>
</html>`;
}

module.exports = { isAuthorized, buildOverview, renderDashboardHtml };
