const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const GAMES_ROOT = path.join(__dirname, 'games');
const ACTIVE_GAMES = new Map();
const webSocketProxy = httpProxy.createProxyServer({});

webSocketProxy.on('error', (error, _req, socket) => {
  console.error('Game stream proxy error:', error.message);
  if (socket && !socket.destroyed) {
    socket.destroy();
  }
});

fs.mkdirSync(GAMES_ROOT, { recursive: true });

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const noCachePath = req.path === '/app.js' || req.path === '/play.html' || req.path.startsWith('/api/logs/');
  if (noCachePath) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/games', express.static(GAMES_ROOT));
app.use('/novnc', express.static('/usr/share/novnc'));

function slugifyName(value) {
  return String(value || '')
    .trim()
    .replace(/https?:\/\/|git@|\.git$/gi, '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'game-project';
}

function prepareRepoDir(repoName) {
  const target = path.join(GAMES_ROOT, repoName);

  if (fs.existsSync(target)) {
    const gitDir = path.join(target, '.git');
    const lockFile = path.join(gitDir, 'index.lock');

    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }

    if (!fs.existsSync(gitDir)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  return target;
}

function appendLog(logFile, text) {
  fs.appendFileSync(logFile, text, 'utf8');
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopTrackedProcess(pid) {
  if (!pid || !isProcessRunning(pid)) {
    return;
  }

  try {
    // Detached children are process-group leaders, so negative PID terminates
    // the full launch tree (shell + spawned game process).
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }
}

function stopOtherActiveGames(currentRepoName) {
  for (const [name, info] of ACTIVE_GAMES.entries()) {
    if (name === currentRepoName) {
      continue;
    }

    stopTrackedProcess(info.pid);
    ACTIVE_GAMES.delete(name);
  }
}

function stopStaleProcessesForRepo(repoName) {
  const lowerName = String(repoName || '').toLowerCase();

  const killPatterns = [];
  if (!lowerName.includes('shattered-pixel-dungeon')) {
    killPatterns.push('com.shatteredpixel.shatteredpixeldungeon.desktop.DesktopLauncher');
    killPatterns.push('/games/shattered-pixel-dungeon/gradle/wrapper/gradle-wrapper.jar');
    killPatterns.push('/games/shattered-pixel-dungeon');
  }

  if (!lowerName.includes('endless-sky')) {
    killPatterns.push('/usr/games/endless-sky');
  }

  if (!lowerName.includes('cataclysm-dda')) {
    killPatterns.push('/games/cataclysm-dda');
    killPatterns.push('cataclysm-launcher');
    killPatterns.push('cataclysm-tiles');
    killPatterns.push('cataclysm-tiles-sdl');
    killPatterns.push('cataclysm');
  }

  for (const pattern of killPatterns) {
    try {
      execFileSync('pkill', ['-9', '-f', pattern]);
    } catch {
      // No matching process is normal; ignore.
    }
  }
}

function hostFromUrl(value) {
  try {
    return new URL(String(value)).host || '';
  } catch {
    return '';
  }
}

function getStreamUrl(req) {
  const host = String(req.get('host') || '');
  const forwardedHost = String(req.get('x-forwarded-host') || '');
  const originHost = hostFromUrl(req.get('origin'));
  const refererHost = hostFromUrl(req.get('referer'));
  const protocol = String(req.get('x-forwarded-proto') || req.protocol || 'http');

  let resolvedHost = forwardedHost || host || originHost || refererHost;
  if (!resolvedHost && host) {
    resolvedHost = host;
  }

  if (!resolvedHost) {
    return null;
  }

  return `${protocol}://${resolvedHost}/novnc/vnc_lite.html?autoconnect=1&path=websockify&resize=off&reconnect=1&view_only=false&show_dot=true`;
}

function needsStream(repoName) {
  const lowerName = String(repoName || '').toLowerCase();
  return lowerName.includes('endless-sky') || lowerName.includes('shattered-pixel-dungeon') || lowerName.includes('cataclysm-dda');
}

function isWebGame(repoName) {
  return String(repoName || '').toLowerCase().includes('bitlife');
}

function detectBuildCommand(repoPath, repoName) {
  const files = {
    packageJson: path.join(repoPath, 'package.json'),
    cargoToml: path.join(repoPath, 'Cargo.toml'),
    cmake: path.join(repoPath, 'CMakeLists.txt'),
    makefile: path.join(repoPath, 'Makefile'),
    sdl: path.join(repoPath, 'src')
  };

  const lowerName = repoName.toLowerCase();

  if (lowerName.includes('bitlife')) {
    return {
      label: 'BitLife (Unity WebGL)',
      command: `cd "${repoPath}" && test -f ./index.html && echo "BitLife WebGL game is ready."`
    };
  }

  if (lowerName.includes('endless-sky')) {
    return {
      label: 'Endless Sky (system package + noVNC stream)',
      command: `mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && if ! pgrep -x Xvfb >/dev/null; then nohup Xvfb :99 -screen 0 1280x720x24 >/tmp/xvfb.log 2>&1 & fi && for i in $(seq 1 25); do DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done && if ! pgrep -x openbox >/dev/null; then DISPLAY=:99 nohup openbox >/tmp/openbox.log 2>&1 & fi && if ! pgrep -x x11vnc >/dev/null; then x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -noxdamage -repeat -bg -o /tmp/x11vnc.log; fi && if ! lsof -iTCP:6080 -sTCP:LISTEN >/dev/null 2>&1; then websockify --web=/usr/share/novnc/ 6080 localhost:5900 --daemon; fi && export DISPLAY=:99 SDL_VIDEO_X11_DGAMOUSE=0 && /usr/games/endless-sky & GAME_PID=$! && for i in $(seq 1 60); do WIN_ID=$(xdotool search --name "Endless Sky" 2>/dev/null | head -n 1) && if [ -n "$WIN_ID" ]; then xdotool windowactivate "$WIN_ID"; xdotool windowfocus "$WIN_ID"; break; fi; sleep 0.2; done && wait $GAME_PID`
    };
  }

  if (lowerName.includes('shattered-pixel-dungeon')) {
    return {
      label: 'Shattered Pixel Dungeon (Gradle desktop + noVNC stream)',
      command: `mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && if ! pgrep -x Xvfb >/dev/null; then nohup Xvfb :99 -screen 0 1280x720x24 >/tmp/xvfb.log 2>&1 & fi && for i in $(seq 1 25); do DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done && if ! pgrep -x openbox >/dev/null; then DISPLAY=:99 nohup openbox >/tmp/openbox.log 2>&1 & fi && if ! pgrep -x x11vnc >/dev/null; then x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -noxdamage -repeat -bg -o /tmp/x11vnc.log; fi && if ! lsof -iTCP:6080 -sTCP:LISTEN >/dev/null 2>&1; then websockify --web=/usr/share/novnc/ 6080 localhost:5900 --daemon; fi && export DISPLAY=:99 JAVA_TOOL_OPTIONS='-DSpecification-Title=ShatteredPixelDungeon -DSpecification-Version=3.0 -DImplementation-Title=com.shatteredpixel.desktop -DImplementation-Version=1' && cd "${repoPath}" && if [ -x ./gradlew ] || [ -f ./gradlew ]; then chmod +x ./gradlew && (./gradlew :desktop:run || ./gradlew desktop:run || ./gradlew lwjgl3:run); else echo "No gradlew found for Shattered Pixel Dungeon."; fi`
    };
  }

  if (lowerName.includes('cataclysm-dda')) {
    return {
      label: 'Cataclysm-DDA (Make tiles + noVNC stream)',
      command: `mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && if ! pgrep -x Xvfb >/dev/null; then nohup Xvfb :99 -screen 0 1280x720x24 >/tmp/xvfb.log 2>&1 & fi && for i in $(seq 1 25); do DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done && if ! pgrep -x openbox >/dev/null; then DISPLAY=:99 nohup openbox >/tmp/openbox.log 2>&1 & fi && if ! pgrep -x x11vnc >/dev/null; then x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -noxdamage -repeat -bg -o /tmp/x11vnc.log; fi && if ! lsof -iTCP:6080 -sTCP:LISTEN >/dev/null 2>&1; then websockify --web=/usr/share/novnc/ 6080 localhost:5900 --daemon; fi && export DISPLAY=:99 && mkdir -p /tmp/cdda-user && if [ -x /usr/games/cataclysm ]; then exec xterm -fa Monospace -fs 13 -geometry 150x45+20+20 -title 'Cataclysm Curses' -e '/usr/games/cataclysm --basepath /usr --userdir /tmp/cdda-user'; elif [ -x /usr/games/cataclysm-tiles ]; then SDL_AUDIODRIVER=dummy exec /usr/games/cataclysm-tiles --basepath /usr --userdir /tmp/cdda-user; fi && cd "${repoPath}" && RUN_EXE="" && if [ -x ./cataclysm-tiles-sdl ]; then RUN_EXE=./cataclysm-tiles-sdl; elif [ -x ./cataclysm-tiles ]; then RUN_EXE=./cataclysm-tiles; elif [ -x ./cataclysm ]; then RUN_EXE=./cataclysm; elif [ -x ./cataclysm-launcher ]; then RUN_EXE=./cataclysm-launcher; fi && if [ -z "$RUN_EXE" ]; then BUILD_MSG_PID=""; if command -v xmessage >/dev/null 2>&1; then xmessage -center -name CataclysmBuild "Cataclysm-DDA is building (low-memory mode). This can take a while." >/dev/null 2>&1 & BUILD_MSG_PID=$!; fi; make -j1 RELEASE=0 TILES=1 SDL3=0 SOUND=0 USE_XDG_DIR=1; BUILD_EXIT=$?; if [ -n "$BUILD_MSG_PID" ]; then kill "$BUILD_MSG_PID" >/dev/null 2>&1 || true; fi; if [ "$BUILD_EXIT" -ne 0 ]; then exit "$BUILD_EXIT"; fi; if [ -x ./cataclysm-tiles-sdl ]; then RUN_EXE=./cataclysm-tiles-sdl; elif [ -x ./cataclysm-tiles ]; then RUN_EXE=./cataclysm-tiles; elif [ -x ./cataclysm ]; then RUN_EXE=./cataclysm; elif [ -x ./cataclysm-launcher ]; then RUN_EXE=./cataclysm-launcher; fi; fi && if [ -n "$RUN_EXE" ]; then "$RUN_EXE"; else echo "No Cataclysm executable found after build."; fi`
    };
  }

  if (fs.existsSync(files.packageJson)) {
    const pkg = JSON.parse(fs.readFileSync(files.packageJson, 'utf8'));
    const scripts = pkg.scripts || {};
    const preferred = scripts.start || scripts.dev || scripts.run || scripts.serve;
    if (preferred) {
      return {
        label: 'Node project',
        command: `cd "${repoPath}" && npm install --silent && npm run ${preferred.includes('node ') ? 'start' : 'run ' + preferred}`
      };
    }
    return {
      label: 'Node project',
      command: `cd "${repoPath}" && npm install --silent && npm start`
    };
  }

  if (fs.existsSync(files.cargoToml)) {
    return {
      label: 'Rust project',
      command: `cd "${repoPath}" && cargo run --release`
    };
  }

  if (fs.existsSync(files.cmake)) {
    return {
      label: 'CMake project',
      command: `cd "${repoPath}" && cmake -S . -B build && cmake --build build -j$(nproc) && find build -type f -executable | head -n 1 | while read exe; do "$exe"; break; done`
    };
  }

  if (fs.existsSync(files.makefile)) {
    return {
      label: 'Make project',
      command: `cd "${repoPath}" && make && find . -maxdepth 3 -type f -executable | head -n 1 | while read exe; do "$exe"; break; done`
    };
  }

  return {
    label: 'Generic project',
    command: `cd "${repoPath}" && ls -la && echo "No known game launch script was found. Add an install or run command in the project config."`
  };
}

function cloneRepo(repoUrl, repoName) {
  const targetDir = path.join(GAMES_ROOT, repoName);

  if (fs.existsSync(path.join(targetDir, '.git'))) {
    return Promise.resolve(targetDir);
  }

  return new Promise((resolve, reject) => {
    execFile('git', ['clone', '--depth', '1', repoUrl, targetDir], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve(targetDir);
    });
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'Game launcher is running' });
});

app.get('/api/games', (_req, res) => {
  const repos = fs.readdirSync(GAMES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(GAMES_ROOT, entry.name)
    }));

  res.json({ repos });
});

app.post('/api/launch', async (req, res) => {
  const repoUrl = String(req.body.repoUrl || '').trim();

  if (!repoUrl) {
    return res.status(400).json({ error: 'A GitHub repo URL is required.' });
  }

  try {
    const repoName = slugifyName(repoUrl);
    const targetDir = prepareRepoDir(repoName);
    const logFile = path.join(GAMES_ROOT, `${repoName}.log`);

    const existing = ACTIVE_GAMES.get(repoName);
    if (existing && isProcessRunning(existing.pid)) {
      return res.json({
        ok: true,
        repoName,
        repoUrl,
        targetDir,
        command: existing.command,
        pid: existing.pid,
        status: 'running',
        popupUrl: `/play.html?repo=${encodeURIComponent(repoName)}`,
        streamUrl: needsStream(repoName) ? getStreamUrl(req) : null,
        webUrl: isWebGame(repoName) ? `/games/${encodeURIComponent(repoName)}/index.html` : null,
        reused: true
      });
    }

    // Only one game should own the shared virtual display stream at a time.
    stopOtherActiveGames(repoName);
    stopStaleProcessesForRepo(repoName);

    // Git refuses to clone into an existing non-empty directory. Make sure the target
    // is absent or already a valid repo before trying to clone or pull.
    if (!fs.existsSync(path.join(targetDir, '.git'))) {
      appendLog(logFile, `Cloning ${repoUrl}\n`);
      await cloneRepo(repoUrl, repoName);
    } else {
      appendLog(logFile, `Repository exists, syncing with remote\n`);
      await cloneRepo(repoUrl, repoName);
    }

    const runPlan = detectBuildCommand(targetDir, repoName);
    let commandOutput = `Starting ${repoName}\n`;
    commandOutput += `Run method: ${runPlan.label}\n`;
    commandOutput += `Command: ${runPlan.command}\n\n`;
    appendLog(logFile, commandOutput);

    const child = spawn('bash', ['-lc', runPlan.command], {
      cwd: targetDir,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    ACTIVE_GAMES.set(repoName, {
      pid: child.pid,
      repoName,
      repoUrl,
      command: runPlan.command,
      logFile
    });

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      appendLog(logFile, text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      appendLog(logFile, text);
    });

    child.on('exit', (code) => {
      appendLog(logFile, `\nProcess exited with code ${code}\n`);
      ACTIVE_GAMES.delete(repoName);
    });

    res.json({
      ok: true,
      repoName,
      repoUrl,
      targetDir,
      command: runPlan.command,
      pid: child.pid,
      status: 'running',
      popupUrl: `/play.html?repo=${encodeURIComponent(repoName)}`,
      streamUrl: needsStream(repoName) ? getStreamUrl(req) : null,
      webUrl: isWebGame(repoName) ? `/games/${encodeURIComponent(repoName)}/index.html` : null
    });
  } catch (error) {
    console.error('Launch failed:', error);
    res.status(500).json({ error: error.message || 'Unable to launch repo.' });
  }
});

app.get('/api/logs/:repoName', (req, res) => {
  const repoName = req.params.repoName;
  const logPath = path.join(GAMES_ROOT, `${repoName}.log`);

  if (!fs.existsSync(logPath)) {
    return res.status(404).json({ error: 'No log file found for this repo.' });
  }

  const logs = fs.readFileSync(logPath, 'utf8');
  res.type('text/plain').send(logs);
});

app.get('/api/games/:repoName', (req, res) => {
  const repoName = req.params.repoName;
  const repoPath = path.join(GAMES_ROOT, repoName);

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repo not found.' });
  }

  const candidates = [];
  const walk = (dir) => {
    if (candidates.length >= 10) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'build') continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower === 'endless-sky' || lower.endsWith('endless-sky') || lower.endsWith('.exe') || lower.endsWith('.app')) {
          candidates.push(fullPath);
        }
      }
    }
  };

  walk(repoPath);

  let detectedExecutable = candidates[0] || null;
  if (!detectedExecutable && repoName.includes('endless-sky') && fs.existsSync('/usr/games/endless-sky')) {
    detectedExecutable = '/usr/games/endless-sky';
  }

  if (!detectedExecutable && repoName.includes('shattered-pixel-dungeon') && fs.existsSync(path.join(repoPath, 'gradlew'))) {
    detectedExecutable = path.join(repoPath, 'gradlew');
  }

  if (!detectedExecutable && repoName.includes('cataclysm-dda')) {
    if (fs.existsSync('/usr/games/cataclysm')) {
      detectedExecutable = '/usr/games/cataclysm';
    } else if (fs.existsSync('/usr/games/cataclysm-tiles')) {
      detectedExecutable = '/usr/games/cataclysm-tiles';
    } else if (fs.existsSync('/usr/bin/cataclysm-tiles')) {
      detectedExecutable = '/usr/bin/cataclysm-tiles';
    } else if (fs.existsSync(path.join(repoPath, 'cataclysm-tiles-sdl'))) {
      detectedExecutable = path.join(repoPath, 'cataclysm-tiles-sdl');
    } else if (fs.existsSync(path.join(repoPath, 'cataclysm-tiles'))) {
      detectedExecutable = path.join(repoPath, 'cataclysm-tiles');
    } else if (fs.existsSync(path.join(repoPath, 'cataclysm'))) {
      detectedExecutable = path.join(repoPath, 'cataclysm');
    } else if (fs.existsSync(path.join(repoPath, 'cataclysm-launcher'))) {
      detectedExecutable = path.join(repoPath, 'cataclysm-launcher');
    } else if (fs.existsSync(path.join(repoPath, 'Makefile'))) {
      // Indicates the repo is ready to build via the Cataclysm launch command.
      detectedExecutable = path.join(repoPath, 'Makefile');
    }
  }

  res.json({
    repoName,
    repoPath,
    executable: detectedExecutable,
    streamUrl: needsStream(repoName) ? getStreamUrl(req) : null,
    webUrl: isWebGame(repoName) && fs.existsSync(path.join(repoPath, 'index.html'))
      ? `/games/${encodeURIComponent(repoName)}/index.html`
      : null
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/websockify')) {
    socket.destroy();
    return;
  }

  webSocketProxy.ws(req, socket, head, { target: 'http://127.0.0.1:6080' });
});

server.listen(PORT, () => {
  console.log(`Game launcher running at http://localhost:${PORT}`);
});
