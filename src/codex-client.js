const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

class CodexClient extends EventEmitter {
  constructor({ appPath, electronPath, codexHome, desktopToolPath }) {
    super();
    this.appPath = appPath;
    this.electronPath = electronPath;
    this.codexHome = codexHome;
    this.desktopToolPath = desktopToolPath;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
    this.ready = false;
  }

  writeConfig() {
    fs.mkdirSync(this.codexHome, { recursive: true });
    const quoted = (value) => JSON.stringify(value);
    const config = [
      'model = "gpt-6-luna"',
      'approval_policy = "on-request"',
      '',
      '[mcp_servers.jarvis_desktop]',
      `command = ${quoted(this.electronPath)}`,
      `args = [${quoted(this.desktopToolPath)}]`,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 90',
      'default_tools_approval_mode = "auto"',
      'required = true',
      '',
      '[mcp_servers.jarvis_desktop.env]',
      'ELECTRON_RUN_AS_NODE = "1"',
      '',
      '[mcp_servers.jarvis_desktop.tools.confirm_high_impact]',
      'approval_mode = "prompt"',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(this.codexHome, 'config.toml'), config, 'utf8');
  }

  resolveLauncher() {
    const bundled = path.join(this.appPath, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(bundled)) {
      return { command: this.electronPath, args: [bundled, 'app-server'], nodeMode: true };
    }
    return { command: 'codex', args: ['app-server'], nodeMode: false };
  }

  async start() {
    if (this.process) return;
    this.writeConfig();
    const launcher = this.resolveLauncher();
    const env = {
      ...process.env,
      CODEX_HOME: this.codexHome,
      HOME: process.env.USERPROFILE || process.env.HOME,
      USERPROFILE: process.env.USERPROFILE || process.env.HOME
    };
    if (launcher.nodeMode) env.ELECTRON_RUN_AS_NODE = '1';
    this.process = spawn(launcher.command, launcher.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) this.emit('diagnostic', message);
    });
    this.process.on('error', (error) => this.fail(error));
    this.process.on('exit', (code) => this.fail(new Error(`Codex App Server 종료 (${code ?? 'unknown'})`)));
    await this.request('initialize', {
      clientInfo: { name: 'jarvis_desktop', title: 'Jarvis', version: '0.1.0-beta.3' },
      capabilities: { experimentalApi: true }
    }, 15000);
    this.notify('initialized', {});
    this.ready = true;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('diagnostic', 'Codex App Server에서 잘못된 응답을 받았습니다.');
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex 요청 실패'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.emit('serverRequest', message);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  send(message) {
    if (!this.process?.stdin?.writable) throw new Error('Codex App Server가 실행 중이지 않습니다.');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 응답 시간이 초과되었습니다.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ method, id, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }
  respond(id, result) { this.send({ id, result }); }

  fail(error) {
    if (!this.process) return;
    this.process = null;
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  stop() {
    const child = this.process;
    this.process = null;
    if (child) child.kill();
  }
}

module.exports = { CodexClient };
