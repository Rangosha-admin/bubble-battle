const crypto = require('crypto');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e7,
    transports: ['websocket'],
    pingInterval: 20000,
    pingTimeout: 20000
});

app.use(express.static('public'));
const path = require('path');

// Раздавать статические файлы из текущей директории
app.use(express.static(__dirname));

// При запросе главной страницы отдавать index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let players = {};
let bubbles = {};
let teams = {};
let teamIdCounter = 0;
let checkpoints = [];
let bubbleIdCounter = 0;
const gameCenter = { lat: 41.3138361, lng: 69.2903755 };

// gameState: 'lobby' -> 'playing' -> 'finale_call' -> 'finale_countdown' -> 'finale_leaderboard' -> 'lobby'
let gameState = 'lobby';
let adminId = null;
let matchEndTime = 0;
let matchTimerInterval = null;
let bubbleSpawnInterval = null;
let finaleCountdownTimeout = null;

// Игровая зона: радиус карты + время на возврат
const ZONE_RADIUS = 375; // метров, совпадает с радиусом на клиенте
const ZONE_GRACE_MS = 90000; // 90 секунд на возврат в зону
let zoneCheckInterval = null;

// Настройки условий завершения матча (задаются Админом в лобби)
let settings = {
    timeLimit: { enabled: true, minutes: 20 },
    poLimit: { enabled: false, po: 100 },
    royale: { enabled: false }
};

const SHOP_DB = {
    'mul2': { cost: 8, type: 'passive', level: 'side', val: 2 },
    'mul3': { cost: 18, type: 'passive', level: 'side', val: 3 },
    'mul4': { cost: 30, type: 'passive', level: 'main', val: 4 },
    'mul5': { cost: 50, type: 'passive', level: 'main', val: 5 },
    'scan': { cost: 5, type: 'consumable', level: 'side' },
    'dash': { cost: 6, type: 'consumable', level: 'side' },
    'smoke': { cost: 8, type: 'consumable', level: 'side' },
    'magnet': { cost: 15, type: 'consumable', level: 'main' },
    'jammer': { cost: 20, type: 'consumable', level: 'main' },
    'trap': { cost: 13, type: 'consumable', level: 'main' },
    'trio': { cost: 30, type: 'passive', level: 'main' }
};

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function generateCheckpoints() {
    checkpoints = [{ id: 'cp_main', lat: gameCenter.lat, lng: gameCenter.lng, type: 'main' }];
    const minR = 185; const maxR = 375; const minDist = 150;
    for (let i = 0; i < 4; i++) {
        let valid = false, lat, lng, attempts = 0;
        while (!valid && attempts < 1000) {
            attempts++;
            const r = Math.sqrt(Math.random() * (maxR * maxR - minR * minR) + minR * minR);
            const theta = Math.random() * 2 * Math.PI;
            lat = gameCenter.lat + (r / 111300) * Math.cos(theta);
            lng = gameCenter.lng + (r / (111300 * Math.cos(gameCenter.lat * Math.PI / 180))) * Math.sin(theta);
            valid = true;
            for (let j = 1; j < checkpoints.length; j++) {
                if (getDistance(lat, lng, checkpoints[j].lat, checkpoints[j].lng) < minDist) { valid = false; break; }
            }
        }
        if (valid) checkpoints.push({ id: `cp_side_${i}`, lat, lng, type: 'side' });
    }
}

function spawnBubble(ownerPlayer = null) {
    if (gameState !== 'playing') return;
    const r = (375 / 111300) * Math.sqrt(Math.random());
    const theta = Math.random() * 2 * Math.PI;
    const lat = gameCenter.lat + r * Math.cos(theta);
    const lng = gameCenter.lng + r * Math.sin(theta) / Math.cos(gameCenter.lat * Math.PI / 180);
    const playerKeys = Object.keys(players);
    if (playerKeys.length === 0) return;

    const randomPlayer = ownerPlayer || players[playerKeys[Math.floor(Math.random() * playerKeys.length)]];
    const id = bubbleIdCounter++;

    let bColor = randomPlayer.color;
    if (randomPlayer.teamId && teams[randomPlayer.teamId]) {
        bColor = teams[randomPlayer.teamId].leaderColor;
    }

    bubbles[id] = { id, lat, lng, color: bColor, ownerId: randomPlayer.id, type: 'normal' };
    io.emit('newBubble', bubbles[id]);
}

// ==================== ЗАВЕРШЕНИЕ / СБРОС ИГРЫ ====================

function stopEntireGame(reason) {
    gameState = 'lobby';
    if (matchTimerInterval) clearInterval(matchTimerInterval);
    if (bubbleSpawnInterval) clearInterval(bubbleSpawnInterval);
    if (finaleCountdownTimeout) clearTimeout(finaleCountdownTimeout);
    if (zoneCheckInterval) clearInterval(zoneCheckInterval);
    matchTimerInterval = null;
    bubbleSpawnInterval = null;
    finaleCountdownTimeout = null;
    zoneCheckInterval = null;
    matchEndTime = 0;

    bubbles = {};
    checkpoints = [];
    teams = {};
    teamIdCounter = 0;
    players = {};
    adminId = null;
    settings = {
        timeLimit: { enabled: true, minutes: 20 },
        poLimit: { enabled: false, po: 100 },
        royale: { enabled: false }
    };

    io.emit('gameReset', { reason });
}

// ==================== ПРОВЕРКА УСЛОВИЙ ПОБЕДЫ ====================

function checkWinConditions() {
    if (gameState !== 'playing') return;

    // Графа 1: лимит времени
    if (settings.timeLimit.enabled && Date.now() >= matchEndTime) {
        triggerFinale('ВРЕМЯ ВЫШЛО!', 'Срочно вернитесь на Главный чекпоинт для подведения итогов!');
        return;
    }

    // Графа 2: лимит победных очков (с учетом альянсов)
    if (settings.poLimit.enabled) {
        let maxPo = 0;
        for (let id in players) {
            let po = players[id].po;
            if (players[id].teamId && teams[players[id].teamId]) po = teams[players[id].teamId].totalPO;
            if (po > maxPo) maxPo = po;
        }
        if (maxPo >= settings.poLimit.po) {
            triggerFinale('ЦЕЛЬ ДОСТИГНУТА!', 'Лимит победных очков набран! Срочно вернитесь на Главный чекпоинт для подведения итогов!');
            return;
        }
    }

    // Графа 3: королевская битва / выживание
    if (settings.royale.enabled) {
        const totalCount = Object.keys(players).length;
        const aliveCount = Object.values(players).filter(p => !p.isDead).length;
        if (totalCount > 1 && aliveCount <= 1) {
            triggerFinale('ПОСЛЕДНИЙ ВЫЖИВШИЙ!', 'В живых остался только один боец! Срочно вернитесь на Главный чекпоинт для подведения итогов!');
            return;
        }
    }
}

// ==================== ИГРОВАЯ ЗОНА ====================

function checkZoneExpirations() {
    if (gameState !== 'playing') return;
    const now = Date.now();
    for (let id in players) {
        const p = players[id];
        if (!p.zoneWarningActive || p.isDead) continue;
        if (now < p.zoneWarningEnd) continue;

        // Время вышло — проверяем, вернулся ли игрок в зону за это время
        if (p.lat != null && p.lng != null) {
            const dist = getDistance(p.lat, p.lng, gameCenter.lat, gameCenter.lng);
            if (dist > ZONE_RADIUS) {
                killByZone(p);
            } else {
                p.zoneWarningActive = false; p.zoneWarningEnd = 0;
                io.to(p.id).emit('zoneWarningClear');
            }
        } else {
            killByZone(p);
        }
    }
}

function killByZone(p) {
    p.isDead = true;
    p.zoneWarningActive = false;
    p.zoneWarningEnd = 0;
    p.shieldEnd = 0; p.killModeEnd = 0;
    if (p.activeEffects) p.activeEffects.dash = 0;

    // Игрок теряет половину своих сырых очков (с учетом альянса)
    if (p.teamId && teams[p.teamId]) {
        const t = teams[p.teamId];
        const lost = Math.floor(t.totalPO / 2);
        t.totalPO -= lost;
        io.emit('teamUpdated', teams);
    } else {
        const lost = Math.floor(p.po / 2);
        p.po -= lost;
    }

    io.to(p.id).emit('zoneDeath');
    io.emit('playerStateChanged', p);
    checkWinConditions();
}

function triggerFinale(title, message) {
    if (gameState !== 'playing') return;
    gameState = 'finale_call';
    if (matchTimerInterval) clearInterval(matchTimerInterval);
    matchTimerInterval = null;

    io.emit('finaleStageOne', { title, message });

    // На случай если все игроки уже физически стоят на базе в момент срабатывания условия
    checkAllAtMainCheckpoint();
}

function checkAllAtMainCheckpoint() {
    if (gameState !== 'finale_call') return;
    const allIds = Object.keys(players);
    if (allIds.length === 0) return;

    const allThere = allIds.every(id => players[id].currentCheckpointId === 'cp_main');
    if (!allThere) return;

    gameState = 'finale_countdown';
    io.emit('finaleCountdownStart', { seconds: 10 });

    finaleCountdownTimeout = setTimeout(() => {
        showFinaleLeaderboard();
    }, 10000);
}

function showFinaleLeaderboard() {
    gameState = 'finale_leaderboard';

    const entries = [];
    const countedTeams = new Set();

    for (let id in players) {
        const p = players[id];
        if (p.teamId && teams[p.teamId]) {
            if (countedTeams.has(p.teamId)) continue;
            countedTeams.add(p.teamId);
            const t = teams[p.teamId];
            entries.push({
                type: 'team',
                teamId: p.teamId,
                color: t.leaderColor,
                po: t.totalPO,
                members: t.members.filter(m => players[m]).map(m => ({ name: players[m].name, photo: players[m].photo }))
            });
        } else {
            entries.push({ type: 'solo', id: p.id, name: p.name, color: p.color, photo: p.photo, po: p.po });
        }
    }

    entries.sort((a, b) => b.po - a.po);

    io.emit('finaleLeaderboard', { entries });
}

function sendPlayerState(socket, player) {
    socket.emit('playerSession', { reconnectToken: player.reconnectToken });
    socket.emit('updateLobby', Object.values(players));
    socket.emit('lobbyState', { isAdmin: player.id === adminId, gameState });

    if (gameState === 'playing') {
        socket.emit('gameStarted', { players, bubbles, checkpoints, teams, matchEndTime, settings });
    }
}

function rebindPlayer(socket, player) {
    const oldId = player.id;
    if (oldId !== socket.id) {
        delete players[oldId];
        player.id = socket.id;
        players[socket.id] = player;

        for (const team of Object.values(teams)) {
            team.members = team.members.map(id => id === oldId ? socket.id : id);
        }
        for (const bubble of Object.values(bubbles)) {
            if (bubble.ownerId === oldId) bubble.ownerId = socket.id;
        }
        if (adminId === oldId) adminId = socket.id;
        io.emit('playerDisconnected', oldId);
        // Сообщаем всем клиентам о переподключившемся игроке под новым id и его последней позиции,
        // иначе его маркер на карте у остальных пропадёт до следующего обновления геолокации
        io.emit('playerStateChanged', player);
    }
    player.connected = true;
    socket.data.playerId = socket.id;
    sendPlayerState(socket, player);
    io.emit('updateLobby', Object.values(players));
}

// ==================== SOCKET HANDLERS ====================

io.on('connection', (socket) => {
    socket.on('joinLobby', (playerData) => {
        const reconnectToken = playerData && playerData.reconnectToken;
        const existingPlayer = Object.values(players).find(p => p.reconnectToken === reconnectToken);
        if (existingPlayer) {
            rebindPlayer(socket, existingPlayer);
            return;
        }

        if (!adminId) adminId = socket.id;
        players[socket.id] = {
            id: socket.id, isAdmin: socket.id === adminId, isDead: false,
            shieldEnd: 0, killModeEnd: 0, killCooldown: 0, inCheckpoint: false, currentCheckpointId: null,
            coins: 0, po: 0, multiplier: 1, inventory: {}, activeEffects: {},
            teamId: null, pendingInvite: null, teamCooldown: 0, canTrio: false,
            zoneWarningActive: false, zoneWarningEnd: 0,
            ...playerData,
            reconnectToken: crypto.randomUUID(), connected: true
        };
        socket.data.playerId = socket.id;
        socket.emit('playerSession', { reconnectToken: players[socket.id].reconnectToken });
        io.emit('updateLobby', Object.values(players));
        socket.emit('lobbyState', { isAdmin: socket.id === adminId, gameState });
    });

    socket.on('resumePlayer', (reconnectToken) => {
        const player = Object.values(players).find(p => p.reconnectToken === reconnectToken);
        if (player) rebindPlayer(socket, player);
    });

    socket.on('startGame', (data) => {
        if (socket.id === adminId && gameState === 'lobby') {
            gameState = 'playing';

            settings = {
                timeLimit: {
                    enabled: !!(data && data.timeLimit && data.timeLimit.enabled),
                    minutes: (data && data.timeLimit && parseInt(data.timeLimit.minutes)) || 20
                },
                poLimit: {
                    enabled: !!(data && data.poLimit && data.poLimit.enabled),
                    po: (data && data.poLimit && parseInt(data.poLimit.po)) || 100
                },
                royale: {
                    enabled: !!(data && data.royale && data.royale.enabled)
                }
            };

            // Если админ ничего не выбрал — подстраховка: включаем лимит времени по умолчанию
            if (!settings.timeLimit.enabled && !settings.poLimit.enabled && !settings.royale.enabled) {
                settings.timeLimit.enabled = true;
                settings.timeLimit.minutes = 20;
            }

            const now = Date.now();
            matchEndTime = settings.timeLimit.enabled ? now + (settings.timeLimit.minutes * 60 * 1000) : 0;

            for (let id in players) players[id].shieldEnd = now + 300000;
            generateCheckpoints();
            for (let i = 0; i < 50; i++) spawnBubble();

            io.emit('gameStarted', { players, bubbles, checkpoints, teams, matchEndTime, settings });

            if (matchTimerInterval) clearInterval(matchTimerInterval);
            matchTimerInterval = setInterval(() => { checkWinConditions(); }, 1000);

            if (bubbleSpawnInterval) clearInterval(bubbleSpawnInterval);
            bubbleSpawnInterval = setInterval(() => {
                const count = Math.floor(Math.random() * 8) + 8;
                for (let i = 0; i < count; i++) spawnBubble();
            }, 10 * 60 * 1000);

            if (zoneCheckInterval) clearInterval(zoneCheckInterval);
            zoneCheckInterval = setInterval(() => { checkZoneExpirations(); }, 1000);
        }
    });

    socket.on('adminStopGame', () => {
        if (socket.id === adminId) {
            stopEntireGame('Игра остановлена администратором.');
        }
    });

    socket.on('finaleAcknowledge', () => {
        if (gameState === 'finale_leaderboard') {
            stopEntireGame('Матч завершен! Спасибо за игру.');
        }
    });

    socket.on('updateLocation', (coords) => {
        const p = players[socket.id];
        if (p) {
            p.lat = coords.lat; p.lng = coords.lng;
            socket.broadcast.emit('playerMoved', { id: socket.id, coords });

            if (gameState === 'playing' && !p.isDead) {
                const dist = getDistance(coords.lat, coords.lng, gameCenter.lat, gameCenter.lng);
                const outOfZone = dist > ZONE_RADIUS;

                if (outOfZone && !p.zoneWarningActive) {
                    p.zoneWarningActive = true;
                    p.zoneWarningEnd = Date.now() + ZONE_GRACE_MS;
                    io.to(p.id).emit('zoneWarningStart', { seconds: ZONE_GRACE_MS / 1000 });
                } else if (!outOfZone && p.zoneWarningActive) {
                    p.zoneWarningActive = false;
                    p.zoneWarningEnd = 0;
                    io.to(p.id).emit('zoneWarningClear');
                }
            }
        }
    });

    socket.on('collectBubble', (bId) => {
        const p = players[socket.id];
        const b = bubbles[bId];
        if (b && p && !p.isDead) {
            delete bubbles[bId];
            io.emit('bubbleCollected', bId);

            let isFriendly = b.ownerId === p.id;
            if (p.teamId && teams[p.teamId] && teams[p.teamId].members.includes(b.ownerId)) isFriendly = true;

            if (b.type === 'trap') {
                if (!isFriendly) p.coins = Math.max(0, p.coins - 5);
            } else if (isFriendly) {
                p.coins += (1 * p.multiplier);
                setTimeout(spawnBubble, 3000);
            } else {
                setTimeout(spawnBubble, 3000);
            }
            io.emit('playerStateChanged', p);
        }
    });

    // ТИМИНГ
    socket.on('invitePlayer', (targetId) => {
        const p = players[socket.id]; const target = players[targetId]; const now = Date.now();
        if (!p || !target || p.isDead || target.isDead) return;
        if (now < p.shieldEnd || now < target.shieldEnd || now < p.teamCooldown || now < target.teamCooldown) return;
        if (target.pendingInvite || p.pendingInvite) return;

        let maxMembers = p.canTrio ? 3 : 2;
        if (p.teamId && teams[p.teamId] && teams[p.teamId].members.length >= maxMembers) return;
        if (target.teamId) return;

        target.pendingInvite = { from: p.id, fromName: p.name };
        io.emit('playerStateChanged', target);
    });

    socket.on('acceptInvite', () => {
        const p = players[socket.id];
        if (!p || !p.pendingInvite || !p.inCheckpoint || p.isDead) return;
        const leader = players[p.pendingInvite.from];
        if (!leader || leader.isDead) { p.pendingInvite = null; io.emit('playerStateChanged', p); return; }

        if (!leader.teamId) {
            leader.teamId = `team_${teamIdCounter++}`;
            teams[leader.teamId] = { members: [leader.id], totalPO: leader.po, leaderColor: leader.color };
            leader.po = 0;
        }

        p.teamId = leader.teamId;
        teams[leader.teamId].members.push(p.id);
        teams[leader.teamId].totalPO += p.po;
        p.po = 0; p.pendingInvite = null;

        io.emit('teamUpdated', teams);
        io.emit('playerStateChanged', leader); io.emit('playerStateChanged', p);
        checkWinConditions();
    });

    socket.on('declineInvite', () => {
        const p = players[socket.id];
        if (p && p.pendingInvite && p.inCheckpoint) { p.pendingInvite = null; io.emit('playerStateChanged', p); }
    });

    socket.on('leaveTeam', () => {
        const p = players[socket.id];
        if (!p || !p.teamId || !p.inCheckpoint || p.coins < 5) return;
        const t = teams[p.teamId]; if (!t) return;

        p.coins -= 5; const now = Date.now();
        const splitAmount = Math.floor(t.totalPO / t.members.length);
        const remainder = t.totalPO % t.members.length;

        t.members.forEach(mId => {
            if (players[mId]) {
                players[mId].po = splitAmount + (mId === p.id ? remainder : 0);
                players[mId].teamId = null;
                players[mId].teamCooldown = now + 300000;
                io.emit('playerStateChanged', players[mId]);
            }
        });
        delete teams[p.teamId];
        io.emit('teamUpdated', teams);
    });

    socket.on('buyItem', (itemId) => {
        const p = players[socket.id];
        if (!p || !p.inCheckpoint) return;

        if (itemId === 'convert') {
            if (p.coins >= 3) {
                p.coins -= 3;
                if (p.teamId && teams[p.teamId]) { teams[p.teamId].totalPO += 1; io.emit('teamUpdated', teams); }
                else { p.po += 1; }
                io.emit('playerStateChanged', p);
                checkWinConditions();
            }
            return;
        }
        const item = SHOP_DB[itemId];
        if (item && p.coins >= item.cost) {
            p.coins -= item.cost;
            if (itemId === 'trio') p.canTrio = true;
            else if (item.type === 'passive') p.multiplier = item.val;
            else p.inventory[itemId] = (p.inventory[itemId] || 0) + 1;
            io.emit('playerStateChanged', p);
        }
    });

    socket.on('useItem', (itemId) => {
        const p = players[socket.id]; const now = Date.now();
        if (p && p.inventory[itemId] > 0 && !p.isDead) {
            p.inventory[itemId] -= 1;
            if (itemId === 'scan') p.activeEffects.scan = now + 30000;
            if (itemId === 'dash') p.activeEffects.dash = now + 20000;
            if (itemId === 'smoke') p.activeEffects.smoke = now + 35000;
            if (itemId === 'magnet') p.activeEffects.magnet = now + 45000;
            if (itemId === 'jammer') {
                for (let pid in players) {
                    if (pid !== p.id) { players[pid].activeEffects.jammed = now + 30000; io.emit('playerStateChanged', players[pid]); }
                }
            }
            if (itemId === 'trap') {
                const id = bubbleIdCounter++;
                bubbles[id] = { id, lat: p.lat, lng: p.lng, color: p.color, ownerId: p.id, type: 'trap' };
                io.emit('newBubble', bubbles[id]);
            }
            io.emit('playerStateChanged', p);
        }
    });

    socket.on('enterCheckpoint', (cpId) => {
        const p = players[socket.id];
        if (p) {
            p.inCheckpoint = true;
            p.currentCheckpointId = cpId || 'cp_main';
            if (p.isDead) p.isDead = false;
            io.emit('playerStateChanged', p);

            if (gameState === 'finale_call') checkAllAtMainCheckpoint();
        }
    });

    socket.on('leaveCheckpoint', () => {
        const p = players[socket.id];
        if (p) {
            p.inCheckpoint = false;
            p.currentCheckpointId = null;
            io.emit('playerStateChanged', p);
        }
    });

    socket.on('activateKillMode', () => {
        const p = players[socket.id]; const now = Date.now();
        if (p && !p.isDead && !p.inCheckpoint && now > p.killCooldown && now > p.shieldEnd) {
            p.killModeEnd = now + 60000; p.killCooldown = now + 240000; p.activeEffects.dash = 0; io.emit('playerStateChanged', p);
        }
    });

    socket.on('tryKill', (targetId) => {
        const killer = players[socket.id]; const target = players[targetId]; const now = Date.now();
        if (!killer || !target || killer.isDead || target.isDead) return;
        if (killer.inCheckpoint || target.inCheckpoint) return;
        if (killer.teamId && killer.teamId === target.teamId) return;

        const targetHasShield = (now < target.shieldEnd) || (now < target.activeEffects.dash);
        if (now > killer.killModeEnd || targetHasShield || now < target.killModeEnd) return;

        target.isDead = true; target.shieldEnd = 0; target.killModeEnd = 0; target.activeEffects.dash = 0;
        const stolen = Math.floor(target.coins / 2);
        target.coins -= stolen; killer.coins += stolen;

        io.emit('playerStateChanged', target); io.emit('playerStateChanged', killer);
        checkWinConditions();
    });

    socket.on('disconnect', () => {
        const p = players[socket.id];
        if (p) p.connected = false;
    });
});

const PORT = 3000;
http.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));
