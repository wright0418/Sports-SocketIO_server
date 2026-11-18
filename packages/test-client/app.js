(() => {
  const { EduSportsMultiplayer } = window.EduSports;

  const ui = {
    connBadge: document.getElementById('connStatusBadge'),
    clientIdLabel: document.getElementById('clientIdLabel'),
    clockOffsetLabel: document.getElementById('clockOffsetLabel'),
    rttLabel: document.getElementById('rttLabel'),
    btnConnect: document.getElementById('btnConnect'),
    btnDisconnect: document.getElementById('btnDisconnect'),
    btnReconnect: document.getElementById('btnReconnect'),

    inputPlayerName: document.getElementById('inputPlayerName'),
    btnAddPlayer: document.getElementById('btnAddPlayer'),
    localPlayersList: document.getElementById('localPlayersList'),

    selectMode: document.getElementById('selectMode'),
    inputDurationSec: document.getElementById('inputDurationSec'),
    btnCreateRoom: document.getElementById('btnCreateRoom'),
    inputRoomCode: document.getElementById('inputRoomCode'),
    chkSpectator: document.getElementById('chkSpectator'),
    btnJoinRoom: document.getElementById('btnJoinRoom'),
    btnLeaveRoom: document.getElementById('btnLeaveRoom'),

    roomInfoBox: document.getElementById('roomInfoBox'),
    roomCodeLabel: document.getElementById('roomCodeLabel'),
    roomModeLabel: document.getElementById('roomModeLabel'),
    roomStateLabel: document.getElementById('roomStateLabel'),
    btnReadyAll: document.getElementById('btnReadyAll'),
    btnStartMatch: document.getElementById('btnStartMatch'),
    btnResetRoom: document.getElementById('btnResetRoom'),
    roomPlayersTable: document.getElementById('roomPlayersTable'),

    matchArena: document.getElementById('matchArena'),
    arenaTitle: document.getElementById('arenaTitle'),
    matchTimerLabel: document.getElementById('matchTimerLabel'),
    bombArenaBox: document.getElementById('bombArenaBox'),
    bombHolderLabel: document.getElementById('bombHolderLabel'),
    bombJumpsLabel: document.getElementById('bombJumpsLabel'),
    bombFuseLabel: document.getElementById('bombFuseLabel'),
    bombFuseBar: document.getElementById('bombFuseBar'),
    bombActionButtons: document.getElementById('bombActionButtons'),
    scoreboardBox: document.getElementById('scoreboardBox'),

    resultBox: document.getElementById('resultBox'),
    resultSummary: document.getElementById('resultSummary'),

    eventLog: document.getElementById('eventLog'),
    btnClearLog: document.getElementById('btnClearLog'),
  };

  let sdk = null;
  let localJumpState = new Map(); // playerId -> { totalJumps, rpm, autoTimer, bleConnected }
  let countdownEndServerTime = null;
  let uiTicker = null;
  let ropeSeq = 1;

  function log(msg, type = 'info') {
    const row = document.createElement('div');
    row.className = `log-entry ${type === 'err' ? 'err' : type === 'ok' ? 'ok' : ''}`;
    const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    row.textContent = `[${time}] ${msg}`;
    ui.eventLog.prepend(row);
  }

  function setConnStatus(connected) {
    ui.connBadge.textContent = connected ? '已連線' : '未連線';
    ui.connBadge.className = `badge ${connected ? 'connected' : 'disconnected'}`;
    ui.btnConnect.disabled = connected;
    ui.btnDisconnect.disabled = !connected;
    ui.btnReconnect.disabled = connected || !sdk;
    ui.btnAddPlayer.disabled = !connected;
    ui.btnCreateRoom.disabled = !connected;
    ui.btnJoinRoom.disabled = !connected;
    ui.btnLeaveRoom.disabled = !connected || !sdk?.getCurrentRoom();
  }

  function resolveServerUrl() {
    const url = new URL('.', window.location.href);
    const cleanedPath = url.pathname
      .replace(/\/test-client\/?$/, '')
      .replace(/\/+$/, '');
    return `${url.origin}${cleanedPath}`;
  }

  function initSdk() {
    if (sdk) return sdk;
    sdk = new EduSportsMultiplayer({
      serverUrl: resolveServerUrl(),
      modeId: ui.selectMode.value,
      tickThrottleMs: 200,
    });

    sdk.on('connected', (reg) => {
      ui.clientIdLabel.textContent = reg.clientInstanceId;
      setConnStatus(true);
      log(`Connected as ${reg.clientInstanceId} (max local: ${reg.maxLocalPlayers})`, 'ok');
    });

    sdk.on('disconnected', ({ reason }) => {
      setConnStatus(false);
      log(`Socket disconnected: ${reason}`, 'err');
    });

    sdk.on('reconnected', ({ restoredSnapshot, replayResults }) => {
      setConnStatus(true);
      log(`Reconnected! Snapshot=${restoredSnapshot ? restoredSnapshot.status : 'none'}, Replays=${replayResults.length}`, 'ok');
      renderRoom(sdk.getCurrentRoom());
      if (restoredSnapshot) renderSnapshot(restoredSnapshot);
    });

    sdk.on('clock:synced', ({ offsetMs, rttMs }) => {
      ui.clockOffsetLabel.textContent = `${Math.round(offsetMs)} ms`;
      ui.rttLabel.textContent = `${Math.round(rttMs)} ms`;
    });

    sdk.on('room:updated', (room) => {
      renderRoom(room);
      ui.btnLeaveRoom.disabled = !sdk.isConnected() || !room;
    });

    sdk.on('player:disconnected', (data) => {
      log(`Players disconnected (30s grace): ${data.playerIds.join(', ')}`, 'err');
    });

    sdk.on('player:reconnected', (data) => {
      log(`Players reconnected: ${data.playerIds.join(', ')}`, 'ok');
    });

    sdk.on('match:countdown', (data) => {
      countdownEndServerTime = data.startAtServerTime;
      ui.resultBox.classList.add('hidden');
      ui.matchArena.classList.remove('hidden');
      ui.arenaTitle.textContent = '比賽倒數中...';
      log(`Match countdown started (${data.countdownMs}ms)`, 'ok');
    });

    sdk.on('match:start', (snapshot) => {
      countdownEndServerTime = null;
      resetLocalJumpCounters();
      ui.resultBox.classList.add('hidden');
      ui.matchArena.classList.remove('hidden');
      ui.arenaTitle.textContent = `比賽進行中 (${snapshot.gameModeId})`;
      log(`Match started: ${snapshot.matchId}`, 'ok');
      renderSnapshot(snapshot);
    });

    sdk.on('game:state', (snapshot) => {
      renderSnapshot(snapshot);
    });

    sdk.on('score:broadcast', (data) => {
      renderScoreboard(data.scores, sdk.getLatestSnapshot()?.modeState);
    });

    sdk.on('game:event', (ev) => {
      log(`Event [${ev.eventType}]: ${JSON.stringify(ev.payload)}`);
    });

    sdk.on('match:finish', (data) => {
      stopAllAutoRopes();
      ui.arenaTitle.textContent = `比賽結束 (${data.reason})`;
      log(`Match finished: ${data.reason}`, 'ok');
    });

    sdk.on('match:result', (result) => {
      renderResult(result);
    });

    sdk.on('server:error', (err) => {
      log(`Server Error [${err.code}]: ${err.message}`, 'err');
    });

    return sdk;
  }

  function resetLocalJumpCounters() {
    for (const st of localJumpState.values()) {
      st.totalJumps = 0;
      st.rpm = 0;
    }
    renderLocalPlayers();
  }

  function stopAllAutoRopes() {
    for (const st of localJumpState.values()) {
      if (st.autoTimer) {
        clearInterval(st.autoTimer);
        st.autoTimer = null;
      }
    }
    renderLocalPlayers();
  }

  function triggerJump(playerId, delta = 1) {
    const st = localJumpState.get(playerId);
    if (!st || !st.bleConnected) return;
    const room = sdk?.getCurrentRoom();
    if (!room || room.status !== 'PLAYING') return;

    st.totalJumps += delta;
    st.rpm = 120 + Math.floor(Math.random() * 40);

    if (room.gameModeId === 'multiplayer') {
      sdk.emitPlayerTick(playerId, 'jump:tick', {
        totalJumps: st.totalJumps,
        deltaJumps: delta,
        rpm: st.rpm,
        energy: st.totalJumps * 2,
      });
    } else if (room.gameModeId === 'bomb-pass') {
      void sdk
        .emitGameEvent(
          playerId,
          'bomb:jump',
          { deltaJumps: delta, rpm: st.rpm },
          { category: 'telemetry' },
        )
        .catch((err) => log(`bomb:jump failed: ${err.message}`, 'err'));
    }

    const countEl = document.getElementById(`jumps-${playerId}`);
    if (countEl) countEl.textContent = String(st.totalJumps);
  }

  function renderLocalPlayers() {
    ui.localPlayersList.innerHTML = '';
    const players = sdk ? sdk.getLocalPlayers() : [];

    for (const p of players) {
      let st = localJumpState.get(p.playerId);
      if (!st) {
        st = { totalJumps: 0, rpm: 0, autoTimer: null, bleConnected: true };
        localJumpState.set(p.playerId, st);
      }

      const card = document.createElement('div');
      card.className = 'player-card';
      card.innerHTML = `
        <div class="player-card-top">
          <div>
            <strong>${p.displayName}</strong>
            <div style="font-size:12px;color:#94a3b8;">${p.deviceId || '無設備'} | ID: ${p.playerId}</div>
          </div>
          <div>跳數: <strong id="jumps-${p.playerId}">${st.totalJumps}</strong></div>
        </div>
        <div class="player-card-actions">
          <button class="btn btn-primary btn-jump">+1 跳</button>
          <button class="btn ${st.autoTimer ? 'btn-warn' : 'btn-secondary'} btn-auto">
            ${st.autoTimer ? '停止自動跳' : '自動跳 (150 RPM)'}
          </button>
          <button class="btn ${st.bleConnected ? 'btn-success' : 'btn-danger'} btn-ble">
            ${st.bleConnected ? 'BLE 已連線' : 'BLE 已斷線'}
          </button>
          <button class="btn btn-secondary btn-ready">準備</button>
          <button class="btn btn-danger btn-remove">移除</button>
        </div>
      `;

      card.querySelector('.btn-jump').onclick = () => triggerJump(p.playerId, 1);

      card.querySelector('.btn-auto').onclick = () => {
        if (st.autoTimer) {
          clearInterval(st.autoTimer);
          st.autoTimer = null;
        } else {
          st.autoTimer = setInterval(() => triggerJump(p.playerId, 1), 400);
        }
        renderLocalPlayers();
      };

      card.querySelector('.btn-ble').onclick = async () => {
        st.bleConnected = !st.bleConnected;
        try {
          await sdk.updateDeviceStatus({
            deviceId: p.deviceId || `Rope_${p.playerId.slice(-4)}`,
            connectionStatus: st.bleConnected ? 'CONNECTED' : 'DISCONNECTED',
            assignedPlayerId: p.playerId,
          });
          log(`${p.displayName} BLE -> ${st.bleConnected ? 'CONNECTED' : 'DISCONNECTED'}`);
        } catch (err) {
          log(`Device status error: ${err.message}`, 'err');
        }
        renderLocalPlayers();
      };

      card.querySelector('.btn-ready').onclick = async () => {
        try {
          const room = sdk.getCurrentRoom();
          const current = room?.players.find((rp) => rp.playerId === p.playerId);
          await sdk.setReady(p.playerId, !(current?.ready ?? false));
        } catch (err) {
          log(`Ready error: ${err.message}`, 'err');
        }
      };

      card.querySelector('.btn-remove').onclick = async () => {
        try {
          if (st.autoTimer) clearInterval(st.autoTimer);
          localJumpState.delete(p.playerId);
          await sdk.removeLocalPlayer(p.playerId);
          renderLocalPlayers();
        } catch (err) {
          log(`Remove player error: ${err.message}`, 'err');
        }
      };

      ui.localPlayersList.appendChild(card);
    }
  }

  function renderRoom(room) {
    if (!room) {
      ui.roomInfoBox.classList.add('hidden');
      ui.matchArena.classList.add('hidden');
      return;
    }
    ui.roomInfoBox.classList.remove('hidden');
    ui.roomCodeLabel.textContent = room.roomCode;
    ui.roomModeLabel.textContent = room.gameModeId;
    ui.roomStateLabel.textContent = room.status;

    ui.roomPlayersTable.innerHTML = '';
    for (const p of room.players) {
      const row = document.createElement('div');
      row.className = 'room-player-row';
      row.innerHTML = `
        <span>${p.displayName} (${p.role})</span>
        <span>${p.connectionStatus === 'CONNECTED' ? '🟢' : '🔴'} ${p.ready ? '✅ 已準備' : '⏳ 未準備'}</span>
      `;
      ui.roomPlayersTable.appendChild(row);
    }
  }

  function renderSnapshot(snapshot) {
    if (!snapshot) return;
    ui.matchArena.classList.remove('hidden');
    renderScoreboard(snapshot.scores, snapshot.modeState);

    if (snapshot.gameModeId === 'bomb-pass') {
      ui.bombArenaBox.classList.remove('hidden');
      const ms = snapshot.modeState || {};
      const holderId = ms.bombHolderPlayerId;
      const holderScore = snapshot.scores.find((s) => s.playerId === holderId);
      ui.bombHolderLabel.textContent = holderScore ? holderScore.displayName : holderId || '-';
      ui.bombJumpsLabel.textContent = `${ms.currentHolderJumps ?? 0} / ${ms.jumpsRequiredToPass ?? 5}`;

      ui.bombActionButtons.innerHTML = '';
      const isMyHolder = sdk.getLocalPlayers().some((lp) => lp.playerId === holderId);
      if (isMyHolder && snapshot.status === 'PLAYING') {
        const canPass = (ms.currentHolderJumps ?? 0) >= (ms.jumpsRequiredToPass ?? 5);
        const btnPass = document.createElement('button');
        btnPass.className = 'btn btn-warn';
        btnPass.disabled = !canPass;
        btnPass.textContent = canPass ? '💣 立刻傳遞炸彈！' : `需跳滿 ${ms.jumpsRequiredToPass} 下才可傳遞`;
        btnPass.onclick = async () => {
          try {
            await sdk.emitGameEvent(holderId, 'bomb:pass', {}, { category: 'critical' });
          } catch (err) {
            log(`bomb:pass error: ${err.message}`, 'err');
          }
        };
        ui.bombActionButtons.appendChild(btnPass);
      }
    } else {
      ui.bombArenaBox.classList.add('hidden');
    }
  }

  function renderScoreboard(scores = [], _modeState) {
    ui.scoreboardBox.innerHTML = '';
    for (const s of scores) {
      const row = document.createElement('div');
      row.className = `score-row ${s.eliminated ? 'eliminated' : ''}`;
      row.innerHTML = `
        <strong>#${s.rank}</strong>
        <span>${s.displayName}</span>
        <span>${s.jumpCount} 跳</span>
        <span>${Math.round(s.rpm)} RPM</span>
        <strong>${s.score} 分</strong>
      `;
      ui.scoreboardBox.appendChild(row);
    }
  }

  function renderResult(result) {
    ui.resultBox.classList.remove('hidden');
    ui.resultSummary.innerHTML = result.participants
      .map(
        (p) =>
          `<div>#${p.rank} <strong>${p.displayName}</strong> — ${p.finalScore} 分 (${p.jumpCount} 跳) [${p.outcome}]</div>`,
      )
      .join('');
  }

  function startUiClockLoop() {
    if (uiTicker) clearInterval(uiTicker);
    uiTicker = setInterval(() => {
      if (!sdk) return;
      const now = sdk.getServerNow();
      const snap = sdk.getLatestSnapshot();

      if (countdownEndServerTime && countdownEndServerTime > now) {
        ui.matchTimerLabel.textContent = `倒數 ${((countdownEndServerTime - now) / 1000).toFixed(1)} s`;
      } else if (snap && snap.status === 'PLAYING' && snap.endsAt) {
        const rem = Math.max(0, snap.endsAt - now);
        ui.matchTimerLabel.textContent = `${(rem / 1000).toFixed(1)} s`;
      }

      if (snap && snap.gameModeId === 'bomb-pass' && snap.modeState?.bombExplodeAtServerTime) {
        const fuseTotal = snap.modeState.fuseDurationMs || 12000;
        const fuseRem = Math.max(0, snap.modeState.bombExplodeAtServerTime - now);
        ui.bombFuseLabel.textContent = `${(fuseRem / 1000).toFixed(1)} s`;
        ui.bombFuseBar.style.width = `${Math.min(100, (fuseRem / fuseTotal) * 100)}%`;
      }
    }, 100);
  }

  // Bind UI Buttons
  ui.btnConnect.onclick = async () => {
    try {
      const client = initSdk();
      await client.connect();
      startUiClockLoop();
    } catch (err) {
      log(`Connect error: ${err.message}`, 'err');
    }
  };

  ui.btnDisconnect.onclick = () => {
    stopAllAutoRopes();
    sdk?.disconnect();
    setConnStatus(false);
    log('Simulated disconnect invoked', 'err');
  };

  ui.btnReconnect.onclick = async () => {
    try {
      await sdk.connect();
    } catch (err) {
      log(`Reconnect error: ${err.message}`, 'err');
    }
  };

  ui.btnAddPlayer.onclick = async () => {
    try {
      const idx = ropeSeq++;
      const name = ui.inputPlayerName.value.trim() || `本地玩家 ${idx}`;
      const deviceId = `Rope_${String(idx).padStart(4, '0')}`;
      await sdk.registerLocalPlayer({ displayName: name, deviceId });
      ui.inputPlayerName.value = '';
      renderLocalPlayers();
      log(`Registered local player: ${name} (${deviceId})`, 'ok');
    } catch (err) {
      log(`Add player failed [${err.code}]: ${err.message}`, 'err');
    }
  };

  ui.btnCreateRoom.onclick = async () => {
    try {
      const durationSec = Number(ui.inputDurationSec.value) || 30;
      const room = await sdk.createRoom({
        gameModeId: ui.selectMode.value,
        config: { durationMs: durationSec * 1000 },
      });
      log(`Created room ${room.roomCode} (${room.gameModeId})`, 'ok');
    } catch (err) {
      log(`Create room failed [${err.code}]: ${err.message}`, 'err');
    }
  };

  ui.btnJoinRoom.onclick = async () => {
    try {
      const code = ui.inputRoomCode.value.trim().toUpperCase();
      if (!code) return;
      const res = await sdk.joinRoom(code, {
        asSpectator: ui.chkSpectator.checked,
      });
      log(`Joined room ${res.room.roomCode}`, 'ok');
    } catch (err) {
      log(`Join room failed [${err.code}]: ${err.message}`, 'err');
    }
  };

  ui.btnLeaveRoom.onclick = async () => {
    try {
      stopAllAutoRopes();
      await sdk.leaveRoom();
      renderRoom(null);
      log('Left room');
    } catch (err) {
      log(`Leave room failed: ${err.message}`, 'err');
    }
  };

  ui.btnReadyAll.onclick = async () => {
    try {
      await sdk.setAllLocalPlayersReady(true);
    } catch (err) {
      log(`Ready all failed: ${err.message}`, 'err');
    }
  };

  ui.btnStartMatch.onclick = async () => {
    try {
      await sdk.requestMatchStart(2000);
    } catch (err) {
      log(`Start match failed [${err.code}]: ${err.message}`, 'err');
    }
  };

  ui.btnResetRoom.onclick = async () => {
    try {
      stopAllAutoRopes();
      const durationSec = Number(ui.inputDurationSec.value) || 30;
      await sdk.resetRoom({
        gameModeId: ui.selectMode.value,
        config: { durationMs: durationSec * 1000 },
      });
      ui.resultBox.classList.add('hidden');
      ui.matchArena.classList.add('hidden');
      log('Room reset for rematch (Web Bluetooth preserved)', 'ok');
    } catch (err) {
      log(`Reset room failed [${err.code}]: ${err.message}`, 'err');
    }
  };

  ui.btnClearLog.onclick = () => {
    ui.eventLog.innerHTML = '';
  };
})();
