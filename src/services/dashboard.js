const config = require('../config/config');
const db = require('../database/database');
const { getRaidStatus } = require('../security/antiRaid');

function isAuthorized(req) {
  if (!config.dashboardToken) return true;
  const authHeader = req.headers.authorization || '';
  if (authHeader === `Bearer ${config.dashboardToken}`) return true;
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
    memberCount: guild?.memberCount || null,
    raid,
    counts: {
      cases: db.getTotalCases(),
      blacklist: db.countBlacklist(),
      ipBans: db.countIpBans(),
      whitelist: db.listWhitelist().length,
    },
    caseStats: db.getCaseStatsByType(),
    recentCases: db.getRecentCases(10),
    config: gcfg,
    rulesCount: 80,
    timestamp: Date.now(),
  };
}

function renderDashboardHtml(tokenParam = '') {
  const querySuffix = tokenParam ? `?token=${encodeURIComponent(tokenParam)}` : '';
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Security Core — 80-Step Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; background: #0b1020; color: #e2e8f0; margin: 0; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    .sub { color: #94a3b8; margin-bottom: 20px; font-size: 13px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: #131b31; border: 1px solid #243052; border-radius: 10px; padding: 14px; }
    .label { color: #94a3b8; font-size: 12px; }
    .val { font-size: 22px; font-weight: bold; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; background: #131b31; border-radius: 10px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #243052; text-align: left; font-size: 13px; }
    th { background: #192442; color: #cbd5e1; }
  </style>
</head>
<body>
  <h1>🛡️ Security Core — 80 Basamakli Guvenlik Paneli</h1>
  <div class="sub" id="meta">Yukleniyor...</div>
  <div class="grid" id="cards"></div>
  <table>
    <thead>
      <tr><th>Vaka</th><th>Tur</th><th>Hedef</th><th>Sebep</th></tr>
    </thead>
    <tbody id="cases"></tbody>
  </table>
  <script>
    async function load() {
      const res = await fetch('/api/overview${querySuffix}');
      if (!res.ok) {
        document.getElementById('meta').textContent = 'Yetkisiz erisim (' + res.status + ')';
        return;
      }
      const d = await res.json();
      document.getElementById('meta').textContent =
        'Sunucu: ' + d.guildName + ' | Bot: ' + d.botTag + ' | Ping: ' + (d.pingMs ?? '-') + 'ms | Kural: ' + d.rulesCount + '/80';
      const items = [
        ['Toplam Vaka', d.counts.cases],
        ['Kara Liste', d.counts.blacklist],
        ['IP / Ag Izolasyonu', d.counts.ipBans],
        ['Guvenli Liste', d.counts.whitelist],
        ['Raid Kalkanı', d.raid.active ? 'AKTIF' : 'Normal'],
        ['AutoMod', d.config.autoMod.enabled ? 'Aktif' : 'Kapali'],
      ];
      document.getElementById('cards').innerHTML = items
        .map(([k, v]) => '<div class="card"><div class="label">' + k + '</div><div class="val">' + v + '</div></div>')
        .join('');
      document.getElementById('cases').innerHTML = (d.recentCases || [])
        .map(c => '<tr><td>' + c.id + '</td><td>' + c.type + '</td><td>' + c.target_id + '</td><td>' + c.reason + '</td></tr>')
        .join('');
    }
    load();
    setInterval(load, 15000);
  </script>
</body>
</html>`;
}

module.exports = { isAuthorized, buildOverview, renderDashboardHtml };
