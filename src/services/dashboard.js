const config = require('../config/config');
const db = require('../database/database');
const { getRaidStatus } = require('../security/antiRaid');

const RULES_80 = [
  // 1-10 Anti-Nuke
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
  // 11-20 Anti-Raid & Anti-Alt & Voice
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
  // 21-30 AutoMod 2.0 & Scam/Phishing
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
  // 31-40 Webhook, Bot, Thread, Emoji, Sticker, Event
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
  // 41-50 Risk Engine & Davranışsal İstihbarat
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
  // 51-60 Karantina 2.0, İtiraz & Vaka Bütünlüğü
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
  // 61-70 Yedekleme, Snapshot & Rollback
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
  // 71-80 Canlı Config, Denetim, Sağlık & Dashboard
  '71. SQLite guild_config canlı ayar saklama',
  '72. Anti-Nuke eşiğini canlı değiştirme',
  '73. Anti-Raid eşiğini canlı değiştirme',
  '74. AutoMod durumunu canlı açma/kapatma',
  '75. Ayarları JSON dışa/içe aktarma',
  '76. Otomatik güvenlik denetimi (/guvenlik-denetimi)',
  '77. Güvenlik simülasyon testi (/guvenlik-test)',
  '78. Gerçek /health durum kontrol ucu',
  '79. Bot içi özet panel (/panel)',
  '80. Özel Web Dashboard (/dashboard & /api/overview)',
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

function buildOverview(client) {
  const guild = client.guilds.cache.get(config.guildId);
  const raid = getRaidStatus();
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
    counts: {
      cases: db.getTotalCases(),
      blacklist: db.countBlacklist(),
      ipBans: db.countIpBans(),
      whitelist: db.listWhitelist().length,
    },
    caseStats: db.getCaseStatsByType(),
    recentCases: db.getRecentCases(20),
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
  <title>KUSURSUZ SECURITY PORTAL — 80/80</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, Segoe UI, Arial, sans-serif;
      background: #070b14;
      color: #e5e7eb;
      display: flex;
      min-height: 100vh;
    }
    .sidebar {
      width: 245px;
      background: #0d1322;
      border-right: 1px solid #1e293b;
      padding: 20px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .brand {
      font-weight: 700;
      font-size: 15px;
      padding: 8px 10px 16px;
      border-bottom: 1px solid #1e293b;
      color: #38bdf8;
    }
    .nav-btn {
      background: transparent;
      border: 1px solid transparent;
      color: #94a3b8;
      padding: 10px 12px;
      border-radius: 8px;
      text-align: left;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    }
    .nav-btn:hover { background: #131c31; color: #f8fafc; }
    .nav-btn.active { background: #0ea5e922; border-color: #0ea5e966; color: #38bdf8; }
    .main { flex: 1; padding: 24px 28px; overflow-y: auto; }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }
    .title { font-size: 20px; font-weight: 700; margin: 0; }
    .meta { font-size: 12px; color: #94a3b8; margin-top: 4px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .card {
      background: #0d1322;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 14px;
    }
    .k { font-size: 12px; color: #94a3b8; }
    .v { font-size: 22px; font-weight: 700; margin-top: 6px; color: #f8fafc; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #0d1322;
      border: 1px solid #1e293b;
      border-radius: 12px;
      overflow: hidden;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid #1e293b;
      text-align: left;
      font-size: 13px;
    }
    th { background: #131c31; color: #cbd5e1; }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    .form-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-bottom: 16px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    label { font-size: 12px; color: #94a3b8; }
    input, select {
      background: #070b14;
      border: 1px solid #293548;
      color: #f8fafc;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 13px;
    }
    button.action {
      background: #0284c7;
      color: #fff;
      border: none;
      padding: 9px 14px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      font-size: 13px;
    }
    button.action:hover { background: #0369a1; }
    .rules-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 8px;
    }
    .rule-item {
      background: #0d1322;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 12px;
      color: #cbd5e1;
    }
    .auth-box {
      max-width: 420px;
      margin: 60px auto;
      background: #0d1322;
      border: 1px solid #1e293b;
      padding: 24px;
      border-radius: 12px;
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">🛡️ KUSURSUZ PORTAL (80/80)</div>
    <button class="nav-btn active" data-tab="overview">Genel Bakış</button>
    <button class="nav-btn" data-tab="cases">Vakalar & Analitik</button>
    <button class="nav-btn" data-tab="settings">Canlı Ayarlar</button>
    <button class="nav-btn" data-tab="rules">80 Kural Matrisi</button>
  </aside>

  <main class="main">
    <div id="authScreen" class="auth-box" style="display:none;">
      <h2 style="margin-top:0;">Panel Erişim Anahtarı</h2>
      <p style="font-size:13px;color:#94a3b8;">DASHBOARD_TOKEN değerini girerek panele bağlan.</p>
      <div class="field" style="margin-bottom:12px;">
        <label for="tokenInput">Token</label>
        <input id="tokenInput" type="password" placeholder="DASHBOARD_TOKEN" />
      </div>
      <button class="action" id="saveTokenBtn">Giriş Yap</button>
    </div>

    <div id="appContent">
      <div class="topbar">
        <div>
          <h1 class="title">Güvenlik Komuta Merkezi</h1>
          <div class="meta" id="metaLine">Yükleniyor...</div>
        </div>
        <button class="action" id="backupBtn">Anlık Yedek Al</button>
      </div>

      <section id="tab-overview" class="tab-pane active">
        <div class="grid" id="statCards"></div>
        <table>
          <thead>
            <tr><th>Vaka</th><th>Tür</th><th>Hedef</th><th>Sebep</th></tr>
          </thead>
          <tbody id="overviewCases"></tbody>
        </table>
      </section>

      <section id="tab-cases" class="tab-pane">
        <div class="grid" id="typeStats"></div>
        <table>
          <thead>
            <tr><th>Vaka</th><th>Tür</th><th>Hedef</th><th>Sebep</th></tr>
          </thead>
          <tbody id="allCases"></tbody>
        </table>
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
          <div id="settingsStatus" style="font-size:13px;color:#38bdf8;"></div>
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

    function headers() {
      return token ? { 'Content-Type': 'application/json', 'x-dashboard-token': token } : { 'Content-Type': 'application/json' };
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

    document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
      const payload = {
        antiNukeThreshold: Number(document.getElementById('anThreshold').value),
        raidJoinThreshold: Number(document.getElementById('raidThreshold').value),
        autoModEnabled: document.getElementById('automodState').value === 'true',
      };
      const res = await fetch('/api/config', { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
      const data = await res.json();
      document.getElementById('settingsStatus').textContent = res.ok ? 'Ayarlar kaydedildi.' : (data.error || 'Hata oluştu.');
      refresh();
    });

    document.getElementById('backupBtn').addEventListener('click', async () => {
      const res = await fetch('/api/backup', { method: 'POST', headers: headers() });
      const data = await res.json();
      alert(res.ok ? 'Yedek alındı: ' + data.file : (data.error || 'Yedek alınamadı.'));
    });

    async function refresh() {
      const res = await fetch('/api/overview', { headers: headers() });
      if (res.status === 401) {
        document.getElementById('authScreen').style.display = 'block';
        document.getElementById('appContent').style.display = 'none';
        return;
      }
      const d = await res.json();
      document.getElementById('metaLine').textContent =
        'Sunucu: ' + d.guildName + ' | Bot: ' + d.botTag + ' | Ping: ' + (d.pingMs ?? '-') + 'ms | Kurallar: ' + d.rulesCount + '/80';

      const cards = [
        ['Toplam Vaka', d.counts.cases],
        ['Kara Liste', d.counts.blacklist],
        ['IP / Ağ İzolasyonu', d.counts.ipBans],
        ['Güvenli Liste', d.counts.whitelist],
        ['Raid Kalkanı', d.raid.active ? 'AKTİF' : 'Normal'],
        ['AutoMod', d.config.autoMod.enabled ? 'Aktif' : 'Kapalı'],
      ];
      document.getElementById('statCards').innerHTML = cards
        .map(([k, v]) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>')
        .join('');

      const rows = (d.recentCases || [])
        .map(c => '<tr><td>' + c.id + '</td><td>' + c.type + '</td><td>' + c.target_id + '</td><td>' + c.reason + '</td></tr>')
        .join('');
      document.getElementById('overviewCases').innerHTML = rows;
      document.getElementById('allCases').innerHTML = rows;

      document.getElementById('typeStats').innerHTML = (d.caseStats || [])
        .map(s => '<div class="card"><div class="k">' + s.type + '</div><div class="v">' + s.cnt + '</div></div>')
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
