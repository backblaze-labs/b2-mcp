import { spawnSync } from "node:child_process";

describe("HTTP auth hook failures", () => {
  it("C26 returns a 500 when the auth hook throws", () => {
    const script = `
      const http = require('node:http');
      const { buildHttpServer } = require('./src/http-server.ts');
      const handle = buildHttpServer({
        getAuthInfo() { throw new Error('private-auth-hook-error'); },
        idleSweepMode: 'request',
      });
      handle.server.listen(0, '127.0.0.1', () => {
        const port = handle.server.address().port;
        http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            console.log(JSON.stringify({ status: res.statusCode, body }));
            handle.drain();
            handle.server.close();
          });
        });
      });
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, B2_HTTP_CREDENTIAL_MODE: "headers" },
      encoding: "utf8",
      timeout: 10000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    });
  });
});
