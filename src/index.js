http
  .createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${config.port}`);

    if (parsedUrl.pathname === '/health') {
      const ready = Boolean(client.isReady() && client.user);
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: ready ? 'ok' : 'starting',
          botReady: ready,
          pingMs: ready ? client.ws.ping : null,
          uptimeSec: Math.floor(process.uptime()),
          timestamp: Date.now(),
        })
      );
      return;
    }

    if (parsedUrl.pathname === '/api/overview') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(buildOverview(client)));
      return;
    }

    if (parsedUrl.pathname === '/api/config' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          db.updateGuildConfigPatch((c) => {
            if (typeof parsed.antiNukeThreshold === 'number') {
              c.antiNuke.threshold = Math.max(1, Math.min(20, parsed.antiNukeThreshold));
            }
            if (typeof parsed.raidJoinThreshold === 'number') {
              c.raid.joinThreshold = Math.max(2, Math.min(50, parsed.raidJoinThreshold));
            }
            if (typeof parsed.autoModEnabled === 'boolean') {
              c.autoMod.enabled = parsed.autoModEnabled;
            }
            return c;
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Gecersiz JSON' }));
        }
      });
      return;
    }

    if (parsedUrl.pathname === '/api/backup' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      (async () => {
        try {
          const guild = client.guilds.cache.get(config.guildId);
          if (guild) await captureGuildSnapshot(guild, logger);
          const backupPath = await db.createBackupSnapshot();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, file: backupPath.split('/').pop() }));
        } catch (err) {
          logger.logError('DASHBOARD_BACKUP', err);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Yedek alinamadi' }));
        }
      })();
      return;
    }

    if (parsedUrl.pathname === '/dashboard') {
      if (!isAuthorized(req)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboardHtml(''));
        return;
      }
      const tokenParam = parsedUrl.searchParams.get('token') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml(tokenParam));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('7/24 aktif ve calisiyor');
  })
  .listen(config.port, () => {
    logger.logInfo('HTTP', `Sunucu ${config.port} portunda aktif.`);
  });
