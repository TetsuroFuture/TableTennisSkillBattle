// ==========================================================
// TableTennisSkillsBattle - ゲームロジック
// 卓球育成ゲーム Phase8
// ==========================================================

const LOCAL_PLAYER_ID_KEY = 'ttsb_player_id';
const LOCAL_SETUP_COMPLETE_KEY = 'ttsb_setup_complete';

// ============================================================
// バランス調整定数
// ============================================================

const BALANCE_CONFIG = {
  exp: {
    base: 10,
    winBonus: 14,
    loseBonus: 4,
    drawBonus: 8,
    closeMatchBonus: 3,
    maxPerBattle: 32
  },

  growth: {
    baseStat: 50,
    maxEffectiveGain: 50,
    growthRate: 45,
    rawStatSoftCap: 120
  },

  skill: {
    maxLevel: 5,
    requiredExp: {
      1: 0,
      2: 40,
      3: 100,
      4: 200,
      5: 360
    }
  },

  battle: {
    statWeight: 0.65,
    skillWeight: 0.25,
    styleAffinityWeight: 0.10
  }
};

let db = null;
let isFirebaseReady = false;
let currentPlayerId = null;
let autoSaveTimerId = null;
const pendingAutoSaveReasons = new Set();
let isNewPlayerSetup = false;

// ============================================================
// 画面状態管理
// ============================================================

const SCREEN_NAMES = ['home', 'training', 'battleModeSelect', 'battleStart', 'battle', 'battleResult', 'data', 'settings'];
let currentScreen = 'home';

let battleStartCpu = null;
let lastBattleResult = null;

function changeScreen(screenName) {
    if (!SCREEN_NAMES.includes(screenName)) {
        console.warn('changeScreen: 不明な画面名:', screenName);
        return;
    }

    SCREEN_NAMES.forEach(name => {
        const el = document.getElementById('screen-' + name);
        if (el) {
            el.style.display = (name === screenName) ? 'block' : 'none';
        }
    });

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.screen === screenName);
    });

    currentScreen = screenName;

    if (screenName === 'battleStart') {
        renderBattleStartScreen();
    }

    if (screenName === 'battleResult') {
        renderBattleResultScreen();
    }
}

function setupNavButtons() {
    document.querySelectorAll('.nav-btn, .home-menu-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.screen;
            if (target) {
                changeScreen(target);
            }
        });
    });
}

// ============================================================
// 対戦モード選択画面
// ============================================================

function showBattleModeSelectScreen() {
    changeScreen('battleModeSelect');
}

function handleSelectCpuBattle() {
    changeScreen('battleStart');
}

function handleSelectRatedBattle() {
    changeScreen('battleStart');
}

function setupBattleModeSelectButtons() {
    const cpuBtn = document.getElementById('selectCpuBattleBtn');
    if (cpuBtn) {
        cpuBtn.addEventListener('click', handleSelectCpuBattle);
    }

    const ratedBtn = document.getElementById('selectRatedBattleBtn');
    if (ratedBtn) {
        ratedBtn.addEventListener('click', handleSelectRatedBattle);
    }
}

function renderBattleStartScreen() {
    const playerNameEl = document.getElementById('bsPlayerName');
    const playerStyleEl = document.getElementById('bsPlayerStyle');
    const playerStatsEl = document.getElementById('bsPlayerStats');
    const cpuNameEl = document.getElementById('bsCpuName');
    const cpuStyleEl = document.getElementById('bsCpuStyle');
    const cpuStatsEl = document.getElementById('bsCpuStats');

    if (!playerNameEl) {
        return;
    }

    playerNameEl.textContent = player.name;
    playerStyleEl.textContent = player.style !== null ? styles[player.style].name : '未選択';
    playerStatsEl.textContent =
        `ATK: ${player.atk}  DEF: ${player.def}  SPD: ${player.spd}  TEC: ${player.tec}  STA: ${player.sta}`;

    battleStartCpu = createCpuOpponent();
    cpuNameEl.textContent = battleStartCpu.name;
    cpuStyleEl.textContent = styles[battleStartCpu.style].name;
    cpuStatsEl.textContent =
        `ATK: ${battleStartCpu.atk}  DEF: ${battleStartCpu.def}  SPD: ${battleStartCpu.spd}  TEC: ${battleStartCpu.tec}  STA: ${battleStartCpu.sta}`;
}

// ============================================================

function renderBattleResultScreen() {
    if (!lastBattleResult) {
        return;
    }

    const r = lastBattleResult;

    const banner = document.getElementById('brResultBanner');
    const resultText = document.getElementById('brResultText');
    if (banner && resultText) {
        banner.classList.remove('br-win', 'br-lose');
        if (r.isTournament) {
            const isChampion = r.wins === 3;
            resultText.textContent = isChampion ? '🏆 大会優勝！' : `大会終了（${r.wins}勝）`;
            banner.classList.add(isChampion ? 'br-win' : 'br-lose');
        } else {
            resultText.textContent = r.isPlayerWin ? '🎉 勝利！' : '😢 敗北...';
            banner.classList.add(r.isPlayerWin ? 'br-win' : 'br-lose');
        }
    }

    const setEl = (id, text) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = text;
        }
    };

    setEl('brPlayerName', r.playerName);
    setEl('brPlayerStyle', r.playerStyle);
    setEl('brCpuName', r.cpuName);
    setEl('brCpuStyle', r.cpuStyle);
    setEl('brPlayerPower', r.playerPower.toFixed(1));
    setEl('brCpuPower', r.cpuPower.toFixed(1));
    setEl('brExpGained', `+${r.expGained} EXP`);
    setEl('brPlayerLevel', `Lv ${r.playerLevel}`);
    setEl('brPlayerExp', `${r.playerExp} EXP`);
    setEl('brRecord', `${r.playerWins}勝 ${r.playerLosses}敗`);

    const logEl = document.getElementById('brBattleLog');
    if (logEl) {
        logEl.innerHTML = r.battleLines
            .map(line => `<div class="battle-log-entry">${line}</div>`)
            .join('');
    }
}

// ============================================================

function updateSaveStatus(message) {
    const statusElement = document.getElementById('saveStatusText');
    if (!statusElement) {
        return;
    }
    statusElement.textContent = message;
}

function setManualSaveButtonEnabled(enabled) {
    const button = document.getElementById('manualSaveBtn');
    if (!button) {
        return;
    }
    button.disabled = !enabled;
}

function initFirebase() {
    try {
        if (typeof firebase === 'undefined') {
            throw new Error('Firebase SDKが読み込まれていません。');
        }

        if (typeof firebaseConfig === 'undefined' || !firebaseConfig || !firebaseConfig.projectId) {
            throw new Error('firebaseConfig が見つかりません。');
        }

        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }

        db = firebase.firestore();
        isFirebaseReady = true;

        updateSaveStatus('Firebase接続済み');
        setManualSaveButtonEnabled(true);
        console.log('Firebase initialized');
    } catch (error) {
        db = null;
        isFirebaseReady = false;
        updateSaveStatus('Firebase接続失敗: オフラインモード');
        setManualSaveButtonEnabled(false);
        console.error('Firebase initialization failed', error);
    }
}

function getOrCreatePlayerId() {
    let playerId = localStorage.getItem(LOCAL_PLAYER_ID_KEY);

    if (!playerId) {
        playerId = `player_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        localStorage.setItem(LOCAL_PLAYER_ID_KEY, playerId);
    }

    return playerId;
}

async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(String(password));
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function createDefaultPlayer(playerId) {
    return {
        playerId: playerId,
        name: '新人選手',
        level: 1,
        style: null,
        atk: 10,
        def: 10,
        spd: 10,
        tec: 10,
        sta: 10,
        exp: 0,
        usableExp: 0,
        skills: [],
        equippedSkills: [],
        wins: 0,
        losses: 0,
        rate: 1500,
        ratedMatches: 0,
        ratedWins: 0,
        ratedLosses: 0,
        ratedDraws: 0,
        lastRatedBattleAt: null,
        initialSetupCompleted: false,
        createdAt: isFirebaseReady ? firebase.firestore.FieldValue.serverTimestamp() : null,
        updatedAt: isFirebaseReady ? firebase.firestore.FieldValue.serverTimestamp() : null
    };
}

function normalizePlayerData(data, playerId) {
    const exp = Number.isFinite(data?.exp) ? data.exp : 0;
    const unspentExp = Number.isFinite(data?.unspentExp)
        ? data.unspentExp
        : (Number.isFinite(data?.usableExp) ? data.usableExp : 0);

    const normalized = {
        playerId: data?.playerId || playerId,
        name: data?.name || '新人選手',
        level: Number.isFinite(data?.level) ? data.level : 1,
        style: Number.isFinite(data?.style) ? data.style : null,
        atk: Number.isFinite(data?.atk) ? data.atk : 10,
        def: Number.isFinite(data?.def) ? data.def : 10,
        spd: Number.isFinite(data?.spd) ? data.spd : 10,
        tec: Number.isFinite(data?.tec) ? data.tec : 10,
        sta: Number.isFinite(data?.sta) ? data.sta : 10,
        exp: exp,
        usableExp: unspentExp,
        skills: Array.isArray(data?.skills) ? data.skills : [],
        equippedSkills: Array.isArray(data?.equippedSkills) ? data.equippedSkills : [],
        wins: Number.isFinite(data?.wins) ? data.wins : 0,
        losses: Number.isFinite(data?.losses) ? data.losses : 0,
        rate: Number.isFinite(data?.rate) ? data.rate : 1500,
        ratedMatches: Number.isFinite(data?.ratedMatches) ? data.ratedMatches : 0,
        ratedWins: Number.isFinite(data?.ratedWins) ? data.ratedWins : 0,
        ratedLosses: Number.isFinite(data?.ratedLosses) ? data.ratedLosses : 0,
        ratedDraws: Number.isFinite(data?.ratedDraws) ? data.ratedDraws : 0,
        lastRatedBattleAt: data?.lastRatedBattleAt ?? null,
        initialSetupCompleted: data?.initialSetupCompleted === true
    };

    if (normalized.level < 1) {
        normalized.level = 1;
    }

    return normalized;
}

function mapPlayerToFirestoreData(targetPlayer, playerId) {
    const nowTimestamp = firebase.firestore.FieldValue.serverTimestamp();
    const unspentExp = Number.isFinite(targetPlayer.usableExp) ? targetPlayer.usableExp : 0;
    const totalExp = Number.isFinite(targetPlayer.exp) ? targetPlayer.exp : 0;

    return {
        playerId,
        name: targetPlayer.name,
        level: targetPlayer.level,
        exp: totalExp,
        unspentExp,
        usedExp: Math.max(0, totalExp - unspentExp),
        mainType: null,
        style: targetPlayer.style,
        atk: targetPlayer.atk,
        def: targetPlayer.def,
        spd: targetPlayer.spd,
        tec: targetPlayer.tec,
        sta: targetPlayer.sta,
        skills: Array.isArray(targetPlayer.skills) ? targetPlayer.skills : [],
        equippedSkills: Array.isArray(targetPlayer.equippedSkills) ? targetPlayer.equippedSkills : [],
        wins: Number.isFinite(targetPlayer.wins) ? targetPlayer.wins : 0,
        losses: Number.isFinite(targetPlayer.losses) ? targetPlayer.losses : 0,
        rate: Number.isFinite(targetPlayer.rate) ? targetPlayer.rate : 1500,
        ratedMatches: Number.isFinite(targetPlayer.ratedMatches) ? targetPlayer.ratedMatches : 0,
        ratedWins: Number.isFinite(targetPlayer.ratedWins) ? targetPlayer.ratedWins : 0,
        ratedLosses: Number.isFinite(targetPlayer.ratedLosses) ? targetPlayer.ratedLosses : 0,
        ratedDraws: Number.isFinite(targetPlayer.ratedDraws) ? targetPlayer.ratedDraws : 0,
        lastRatedBattleAt: targetPlayer.lastRatedBattleAt ?? null,
        initialSetupCompleted: targetPlayer.initialSetupCompleted === true,
        updatedAt: nowTimestamp
    };
}

function applyPlayerDataToRuntime(data) {
    player.name = data.name;
    player.level = data.level;
    player.style = data.style;
    player.atk = data.atk;
    player.def = data.def;
    player.spd = data.spd;
    player.tec = data.tec;
    player.sta = data.sta;
    player.exp = data.exp;
    player.usableExp = data.usableExp;
    player.skills = data.skills;
    player.equippedSkills = data.equippedSkills;
    player.wins = data.wins;
    player.losses = data.losses;
    player.rate = data.rate;
    player.ratedMatches = data.ratedMatches;
    player.ratedWins = data.ratedWins;
    player.ratedLosses = data.ratedLosses;
    player.ratedDraws = data.ratedDraws;
    player.lastRatedBattleAt = data.lastRatedBattleAt;
    player.initialSetupCompleted = data.initialSetupCompleted;
    cleanupEquippedSkills(player);
}

async function savePlayerData(saveLabel = '保存中...') {
    if (!isFirebaseReady || !db || !currentPlayerId) {
        return false;
    }

    updateSaveStatus(saveLabel);

    try {
        const docRef = db.collection('players').doc(currentPlayerId);
        const saveData = mapPlayerToFirestoreData(player, currentPlayerId);

        await docRef.set(saveData, { merge: true });

        updateSaveStatus(`保存完了 (${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })})`);
        return true;
    } catch (error) {
        updateSaveStatus('保存失敗: オフラインモード継続');
        console.error('Failed to save player data', error);
        return false;
    }
}

function getAutoSaveLabel(reasons) {
    if (reasons.includes('initial_setup')) {
        return '初期設定を保存中...';
    }
    if (reasons.includes('battle_finished')) {
        return '試合後自動保存中...';
    }
    if (reasons.includes('match_finished')) {
        return '試合結果を保存中...';
    }
    if (reasons.includes('tournament_finished')) {
        return '大会結果を保存中...';
    }
    if (reasons.includes('level_up')) {
        return 'レベルアップ後保存中...';
    }
    if (reasons.includes('training_upgraded')) {
        return '育成結果を保存中...';
    }
    if (reasons.includes('skill_gained')) {
        return 'スキル獲得を保存中...';
    }
    if (reasons.includes('skill_equipped') || reasons.includes('skill_unequipped')) {
        return 'スキル装備変更を保存中...';
    }
    return '自動保存中...';
}

function autoSavePlayer(reason = 'auto') {
    if (!isFirebaseReady) {
        return;
    }

    pendingAutoSaveReasons.add(reason);

    if (autoSaveTimerId !== null) {
        return;
    }

    updateSaveStatus('自動保存待機中...');
    autoSaveTimerId = setTimeout(() => {
        const reasons = Array.from(pendingAutoSaveReasons);
        pendingAutoSaveReasons.clear();
        autoSaveTimerId = null;

        const label = getAutoSaveLabel(reasons);
        savePlayerData(label).catch(error => {
            console.error('Auto save failed', error);
        });
    }, 250);
}

function triggerAutoSave() {
    autoSavePlayer('auto');
}

async function saveMatchResult(matchResult) {
    if (!isFirebaseReady || !db || !currentPlayerId) {
        return false;
    }

    try {
        await db.collection('matches').add({
            playerId: currentPlayerId,
            playerName: player.name,
            playerStyle: matchResult.playerStyle,
            enemyName: matchResult.enemyName || null,
            enemyStyle: matchResult.enemyStyle,
            mode: matchResult.mode || 'practice',
            tacticId: matchResult.tacticId || null,
            tacticName: matchResult.tacticName || null,
            rivalId: matchResult.rivalId || null,
            result: matchResult.result,
            winRate: matchResult.winRate,
            expGained: matchResult.expGained,
            roundsWon: Number.isFinite(matchResult.roundsWon) ? matchResult.roundsWon : null,
            isChampion: Boolean(matchResult.isChampion),
            log: Array.isArray(matchResult.log) ? matchResult.log : [],
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return true;
    } catch (error) {
        console.error('Failed to save match result', error);
        return false;
    }
}

async function loadOrCreatePlayerData() {
    currentPlayerId = getOrCreatePlayerId();

    if (!isFirebaseReady || !db) {
        updateSaveStatus('オフラインモード: Firebase未接続');
        return;
    }

    try {
        updateSaveStatus('プレイヤーデータ読込中...');

        const docRef = db.collection('players').doc(currentPlayerId);
        const snapshot = await docRef.get();

        if (snapshot.exists) {
            const loaded = normalizePlayerData(snapshot.data(), currentPlayerId);
            applyPlayerDataToRuntime(loaded);
            updateSaveStatus('データ読込完了');
            addLog('Firestoreからプレイヤーデータを読み込みました。', 'success');
            return;
        }

        const initialData = createDefaultPlayer(currentPlayerId);
        applyPlayerDataToRuntime(normalizePlayerData(initialData, currentPlayerId));
        await db.collection('players').doc(currentPlayerId).set({
            ...mapPlayerToFirestoreData(player, currentPlayerId),
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        updateSaveStatus('新規プレイヤー作成完了');
        addLog('初回アクセスのため、新規プレイヤーデータを作成しました。', 'info');
    } catch (error) {
        updateSaveStatus('読込失敗: ローカル進行のみ');
        console.error('Failed to load/create player data', error);
        addLog('Firestoreの読み込みに失敗したため、ローカル進行で続行します。', 'warning');
    }
}

// ゲーム状態管理 - プレイヤーオブジェクト
const player = {
    name: "新人選手",
    level: 1,
    style: null,  // 選択された戦型のインデックス
    atk: 10,
    def: 10,
    spd: 10,
    tec: 10,
    sta: 10,
    exp: 0,         // 総獲得経験値
    usableExp: 0,   // 未使用の経験値
    skills: [],     // 所持スキルID
    equippedSkills: [], // 装備中スキルID
    wins: 0,
    losses: 0,
    rate: 1500,
    ratedMatches: 0,
    ratedWins: 0,
    ratedLosses: 0,
    ratedDraws: 0,
    lastRatedBattleAt: null,
    initialSetupCompleted: false  // 初期設定完了フラグ
};

// 戦型データ - 9種類 + 各説明
const styles = [
    {
        id: 0,
        name: "前陣速攻型",
        category: "攻撃系",
        description: "超高速展開による早期決着型。相手を寄せ付けないペースで攻め続ける。SPD と ATK を特化させた最速の戦型。"
    },
    {
        id: 1,
        name: "オールフォア型",
        category: "攻撃系",
        description: "フォア偏重の攻撃型。位置取りで相手に圧力をかける。ATK と TEC を重視したテクニカルな戦型。"
    },
    {
        id: 2,
        name: "パワー両ハンド型",
        category: "攻撃系",
        description: "両ハンド強打による安定した火力。高い推進力で相手を圧倒する。ATK と STA を特化させた力強い戦型。"
    },
    {
        id: 3,
        name: "ブロック＆カウンター型",
        category: "カウンター系",
        description: "守りからの反撃を主軸とする。相手の攻撃を落ち着いてブロックしてから逆襲する。DEF と TEC を重視。"
    },
    {
        id: 4,
        name: "一撃カウンター型",
        category: "カウンター系",
        description: "決定的な一発の反撃に全てを注ぐ。相手の強攻を読んで一気に決める。TEC と ATK の高い戦型。"
    },
    {
        id: 5,
        name: "オールラウンド型",
        category: "カウンター系",
        description: "全ての場面に対応するバランス型。どんな相手にも柔軟に対応できる調整役。全ステータスの均衡が重要。"
    },
    {
        id: 6,
        name: "ペン粒型",
        category: "守備系",
        description: "変化重視による守備型。奇抜な回転で相手のミスを誘発させる。精密さと変則性が武器。"
    },
    {
        id: 7,
        name: "カットマン型",
        category: "守備系",
        description: "超守備型。粘り強いカットで相手の攻撃を受け流す。STA と DEF を特化させた耐久力重視。"
    },
    {
        id: 8,
        name: "異質攻守型",
        category: "守備系",
        description: "攻守ミックスの変則型。攻と守を組み合わせて相手のリズムを狂わせる。予測不能な動きが特徴。"
    }
];

// Phase4: スキルカード20種類
const skillCards = [
    // 攻撃系
    {
        id: "fast_drive",
        name: "高速ドライブ",
        category: "attack",
        description: "ATK +10%、SPD +5%",
        effectType: "status",
        effects: { atkRate: 0.10, spdRate: 0.05 },
        trigger: "always",
        animationTag: "drive"
    },
    {
        id: "smash_boost",
        name: "スマッシュ強化",
        category: "attack",
        description: "フィニッシュイベント発生率 +10%",
        effectType: "battle",
        effects: { finishRate: 0.10 },
        trigger: "battle",
        animationTag: "smash"
    },
    {
        id: "rush_mode",
        name: "連打モード",
        category: "attack",
        description: "攻撃イベントが連続する確率 +10%",
        effectType: "battle",
        effects: { attackChainRate: 0.10 },
        trigger: "battle",
        animationTag: "rush"
    },
    {
        id: "first_attack",
        name: "先手必勝",
        category: "attack",
        description: "試合序盤の勝率 +8%",
        effectType: "winRate",
        effects: { earlyWinRateBonus: 0.08 },
        trigger: "early",
        animationTag: "first_attack"
    },
    {
        id: "attack_focus",
        name: "攻撃集中",
        category: "attack",
        description: "ATK +8%、TEC +8%",
        effectType: "status",
        effects: { atkRate: 0.08, tecRate: 0.08 },
        trigger: "always",
        animationTag: "power_up"
    },

    // カウンター系
    {
        id: "iron_counter",
        name: "鉄壁カウンター",
        category: "counter",
        description: "DEF +10%、カウンター成功率 +8%",
        effectType: "mixed",
        effects: { defRate: 0.10, counterRate: 0.08 },
        trigger: "battle",
        animationTag: "counter"
    },
    {
        id: "precise_block",
        name: "精密ブロック",
        category: "counter",
        description: "DEF +8%、TEC +8%",
        effectType: "status",
        effects: { defRate: 0.08, tecRate: 0.08 },
        trigger: "always",
        animationTag: "block"
    },
    {
        id: "quick_reaction",
        name: "反射神経強化",
        category: "counter",
        description: "SPD +10%、カウンターイベント発生率 +5%",
        effectType: "mixed",
        effects: { spdRate: 0.10, counterEventRate: 0.05 },
        trigger: "battle",
        animationTag: "quick_reaction"
    },
    {
        id: "counter_smash",
        name: "一撃返し",
        category: "counter",
        description: "不利な攻撃を受けた時、低確率で逆転イベント発生",
        effectType: "battle",
        effects: { comebackEventRate: 0.08 },
        trigger: "disadvantage",
        animationTag: "counter_smash"
    },
    {
        id: "trap_counter",
        name: "誘導反撃",
        category: "counter",
        description: "相手のミスイベント発生率 +8%",
        effectType: "battle",
        effects: { enemyMistakeRate: 0.08 },
        trigger: "battle",
        animationTag: "trap"
    },

    // 守備系
    {
        id: "endurance",
        name: "粘り強化",
        category: "defense",
        description: "STA +15%",
        effectType: "status",
        effects: { staRate: 0.15 },
        trigger: "always",
        animationTag: "endurance"
    },
    {
        id: "full_defense",
        name: "守備極振り",
        category: "defense",
        description: "DEF +15%、ATK -3%",
        effectType: "status",
        effects: { defRate: 0.15, atkRate: -0.03 },
        trigger: "always",
        animationTag: "defense"
    },
    {
        id: "long_rally",
        name: "ラリー延長",
        category: "defense",
        description: "長期戦イベントで勝率 +10%",
        effectType: "winRate",
        effects: { longRallyWinRateBonus: 0.10 },
        trigger: "long_rally",
        animationTag: "long_rally"
    },
    {
        id: "shield",
        name: "耐久シールド",
        category: "defense",
        description: "相手のフィニッシュイベント成功率 -8%",
        effectType: "battle",
        effects: { enemyFinishRate: -0.08 },
        trigger: "battle",
        animationTag: "shield"
    },
    {
        id: "rhythm_break",
        name: "リズム破壊",
        category: "defense",
        description: "相手のSPD補正 -5%",
        effectType: "debuff",
        effects: { enemySpdRate: -0.05 },
        trigger: "battle",
        animationTag: "rhythm_break"
    },

    // 汎用・特殊系
    {
        id: "focus",
        name: "集中力",
        category: "special",
        description: "TEC +15%",
        effectType: "status",
        effects: { tecRate: 0.15 },
        trigger: "always",
        animationTag: "focus"
    },
    {
        id: "stable_action",
        name: "安定行動",
        category: "special",
        description: "ランダムブレ幅を小さくする",
        effectType: "battle",
        effects: { randomRangeRate: -0.20 },
        trigger: "battle",
        animationTag: "stable"
    },
    {
        id: "critical_thinking",
        name: "クリティカル思考",
        category: "special",
        description: "クリティカルイベント率 +10%",
        effectType: "battle",
        effects: { criticalRate: 0.10 },
        trigger: "battle",
        animationTag: "critical"
    },
    {
        id: "comeback_mind",
        name: "逆転思考",
        category: "special",
        description: "劣勢時に勝率 +8%",
        effectType: "winRate",
        effects: { comebackWinRateBonus: 0.08 },
        trigger: "disadvantage",
        animationTag: "comeback"
    },
    {
        id: "style_adapt",
        name: "戦型適応",
        category: "special",
        description: "不利相性を30%軽減",
        effectType: "matchup",
        effects: { disadvantageReduceRate: 0.30 },
        trigger: "matchup",
        animationTag: "adapt"
    }
];

const baseCategoryAdvantage = {
    '攻撃系': '守備系',
    '守備系': 'カウンター系',
    'カウンター系': '攻撃系'
};

const sameCategoryAdvantage = {
    0: 1,
    1: 2,
    2: 0,
    3: 4,
    4: 5,
    5: 3,
    6: 7,
    7: 8,
    8: 6
};

const gameModes = {
    practice: '練習試合',
    rival: 'ライバル戦',
    tournament: '大会モード'
};

const tactics = [
    {
        id: 'first_attack',
        name: '先手重視',
        description: '先手を取りにいく。SPDが上がるがSTAが少し下がる。',
        effects: {
            spdRate: 0.08,
            staRate: -0.03
        }
    },
    {
        id: 'stable',
        name: '安定重視',
        description: 'ミスを減らす。TECが上がるが爆発力は少し下がる。',
        effects: {
            tecRate: 0.08,
            criticalRate: -0.03
        }
    },
    {
        id: 'power',
        name: '強打重視',
        description: '決定力を上げる。ATKが上がるがミスも増える。',
        effects: {
            atkRate: 0.10,
            mistakeRate: 0.05
        }
    },
    {
        id: 'long_rally',
        name: '長期戦重視',
        description: '粘り勝ちを狙う。STAが上がるが序盤は少し弱くなる。',
        effects: {
            staRate: 0.10,
            earlyWinRateBonus: -0.03
        }
    },
    {
        id: 'anti_matchup',
        name: '相性対策',
        description: '不利相性を軽減するが、有利相性の効果も少し下がる。',
        effects: {
            disadvantageReduceRate: 0.20,
            advantageReduceRate: 0.10
        }
    }
];

const rivals = [
    {
        id: 'rival_front_fast_attack',
        name: '速攻のハヤト',
        styleName: '前陣速攻型',
        mainType: '攻撃型',
        description: '早い打点で一気に攻めてくる速攻型ライバル。'
    },
    {
        id: 'rival_all_fore',
        name: 'フォアのレン',
        styleName: 'オールフォア型',
        mainType: '攻撃型',
        description: 'フォアハンドで主導権を握る攻撃型ライバル。'
    },
    {
        id: 'rival_power_both_hand',
        name: '剛腕のダイチ',
        styleName: 'パワー両ハンド型',
        mainType: '攻撃型',
        description: '両ハンドの火力で押し切るパワー型ライバル。'
    },
    {
        id: 'rival_block_counter',
        name: '壁のミナト',
        styleName: 'ブロック＆カウンター型',
        mainType: 'カウンター型',
        description: '堅実なブロックから反撃するカウンター型ライバル。'
    },
    {
        id: 'rival_one_shot_counter',
        name: '一撃のカイ',
        styleName: '一撃カウンター型',
        mainType: 'カウンター型',
        description: '一発の反撃で流れを変えるロマン型ライバル。'
    },
    {
        id: 'rival_all_round',
        name: '万能のソウ',
        styleName: 'オールラウンド型',
        mainType: 'カウンター型',
        description: '相手に合わせて戦う万能型ライバル。'
    },
    {
        id: 'rival_pips',
        name: '粒高のユウ',
        styleName: 'ペン粒型',
        mainType: '守備型',
        description: '変化とテンポ差でミスを誘う守備型ライバル。'
    },
    {
        id: 'rival_chopper',
        name: '削りのシン',
        styleName: 'カットマン型',
        mainType: '守備型',
        description: '粘り強いカットで相手を崩す守備型ライバル。'
    },
    {
        id: 'rival_trickster',
        name: '異質のアオ',
        styleName: '異質攻守型',
        mainType: '守備型',
        description: '変化と攻撃を切り替えるトリッキーなライバル。'
    }
];

let selectedTacticId = 'first_attack';
let currentBattleMode = 'practice';

// ============================================================
// スキル関連関数（Phase4）
// ============================================================

function getSkillById(skillId) {
    return skillCards.find(skill => skill.id === skillId) || null;
}

function getSkillsByCategory(category) {
    return skillCards.filter(skill => skill.category === category);
}

function logAllSkillsForDebug() {
    console.group('Phase4 Skill Cards Debug');
    console.log(`total skills: ${skillCards.length}`);
    skillCards.forEach((skill, index) => {
        console.log(
            `${index + 1}. [${skill.category}] ${skill.name} (${skill.id})`,
            {
                effectType: skill.effectType,
                trigger: skill.trigger,
                animationTag: skill.animationTag,
                effects: skill.effects
            }
        );
    });
    console.groupEnd();
}

function ensurePlayerEquippedSkills(targetPlayer) {
    if (!Array.isArray(targetPlayer.equippedSkills)) {
        targetPlayer.equippedSkills = [];
    }
}

function getEquippedSkills(targetPlayer) {
    ensurePlayerEquippedSkills(targetPlayer);

    return targetPlayer.equippedSkills
        .map(skillId => getSkillById(skillId))
        .filter(Boolean);
}

function getEquippedSkillObjects(targetPlayer) {
    ensurePlayerSkills(targetPlayer);
    ensurePlayerEquippedSkills(targetPlayer);
    cleanupEquippedSkills(targetPlayer);

    return targetPlayer.equippedSkills
        .filter(skillId => targetPlayer.skills.includes(skillId))
        .map(skillId => getSkillById(skillId))
        .filter(skill => skill !== null);
}

function getMaxEquipSlots(level) {
    if (level >= 20) {
        return 5;
    }
    if (level >= 10) {
        return 4;
    }
    if (level >= 5) {
        return 3;
    }
    return 2;
}

function ensurePlayerSkills(targetPlayer) {
    if (!Array.isArray(targetPlayer.skills)) {
        targetPlayer.skills = [];
    }
}

function hasSkill(targetPlayer, skillId) {
    ensurePlayerSkills(targetPlayer);
    return targetPlayer.skills.includes(skillId);
}

function addSkillToPlayer(targetPlayer, skillId) {
    ensurePlayerSkills(targetPlayer);

    const skill = getSkillById(skillId);
    if (!skill) {
        console.warn('存在しないスキルIDです:', skillId);
        return false;
    }

    if (hasSkill(targetPlayer, skillId)) {
        return false;
    }

    targetPlayer.skills.push(skillId);
    addLog(`スキルカード「${skill.name}」を獲得しました！`, 'success');
    autoSavePlayer('skill_gained');
    return true;
}

function equipSkill(targetPlayer, skillId) {
    ensurePlayerSkills(targetPlayer);
    ensurePlayerEquippedSkills(targetPlayer);
    cleanupEquippedSkills(targetPlayer);

    const skill = getSkillById(skillId);
    if (!skill) {
        console.warn('存在しないスキルIDです:', skillId);
        return false;
    }

    if (!hasSkill(targetPlayer, skillId)) {
        addLog(`未所持のスキル「${skill.name}」は装備できません。`, 'warning');
        return false;
    }

    if (isSkillEquipped(targetPlayer, skillId)) {
        addLog(`スキル「${skill.name}」はすでに装備中です。`, 'info');
        return false;
    }

    const maxSlots = getMaxEquipSlots(targetPlayer.level);
    if (targetPlayer.equippedSkills.length >= maxSlots) {
        addLog(`装備枠がいっぱいです。現在の装備枠: ${maxSlots}`, 'warning');
        return false;
    }

    targetPlayer.equippedSkills.push(skillId);
    addLog(`スキル「${skill.name}」を装備しました。`, 'success');
    renderAll();
    autoSavePlayer('skill_equipped');

    return true;
}

function unequipSkill(targetPlayer, skillId) {
    ensurePlayerEquippedSkills(targetPlayer);

    const skill = getSkillById(skillId);
    if (!skill) {
        console.warn('存在しないスキルIDです:', skillId);
        return false;
    }

    if (!isSkillEquipped(targetPlayer, skillId)) {
        addLog(`スキル「${skill.name}」は装備されていません。`, 'info');
        return false;
    }

    targetPlayer.equippedSkills = targetPlayer.equippedSkills.filter(id => id !== skillId);
    addLog(`スキル「${skill.name}」を解除しました。`, 'info');
    renderAll();
    autoSavePlayer('skill_unequipped');

    return true;
}

function cleanupEquippedSkills(targetPlayer) {
    ensurePlayerSkills(targetPlayer);
    ensurePlayerEquippedSkills(targetPlayer);

    const uniqueValidSkillIds = [];

    targetPlayer.equippedSkills.forEach(skillId => {
        if (!targetPlayer.skills.includes(skillId)) {
            return;
        }

        if (!getSkillById(skillId)) {
            return;
        }

        if (uniqueValidSkillIds.includes(skillId)) {
            return;
        }

        uniqueValidSkillIds.push(skillId);
    });

    const maxSlots = getMaxEquipSlots(targetPlayer.level);
    targetPlayer.equippedSkills = uniqueValidSkillIds.slice(0, maxSlots);
}

function isSkillEquipped(targetPlayer, skillId) {
    ensurePlayerEquippedSkills(targetPlayer);
    return targetPlayer.equippedSkills.includes(skillId);
}

function gainRandomSkill(targetPlayer) {
    const unownedSkills = getUnownedSkills(targetPlayer);

    if (unownedSkills.length === 0) {
        addLog('すべてのスキルカードを所持しています。', 'info');
        return null;
    }

    const randomIndex = Math.floor(Math.random() * unownedSkills.length);
    const selectedSkill = unownedSkills[randomIndex];
    const added = addSkillToPlayer(targetPlayer, selectedSkill.id);

    if (added) {
        return selectedSkill;
    }

    return null;
}

function getOwnedSkills(targetPlayer) {
    ensurePlayerSkills(targetPlayer);

    return targetPlayer.skills
        .map(skillId => getSkillById(skillId))
        .filter(Boolean);
}

function getUnownedSkills(targetPlayer) {
    ensurePlayerSkills(targetPlayer);

    return skillCards.filter(skill => !targetPlayer.skills.includes(skill.id));
}

function calculateSkillRateBonuses(character) {
    const equippedSkills = getEquippedSkillObjects(character);
    const bonuses = {
        atkRate: 0,
        defRate: 0,
        spdRate: 0,
        tecRate: 0,
        staRate: 0
    };

    equippedSkills.forEach(skill => {
        const effects = skill.effects || {};
        bonuses.atkRate += effects.atkRate || 0;
        bonuses.defRate += effects.defRate || 0;
        bonuses.spdRate += effects.spdRate || 0;
        bonuses.tecRate += effects.tecRate || 0;
        bonuses.staRate += effects.staRate || 0;
    });

    return bonuses;
}

function applySkillStatusBonus(character) {
    const bonuses = calculateSkillRateBonuses(character);

    return {
        ...character,
        atk: Math.round(character.atk * (1 + bonuses.atkRate)),
        def: Math.round(character.def * (1 + bonuses.defRate)),
        spd: Math.round(character.spd * (1 + bonuses.spdRate)),
        tec: Math.round(character.tec * (1 + bonuses.tecRate)),
        sta: Math.round(character.sta * (1 + bonuses.staRate))
    };
}

function calculateSkillWinRateBonus(targetPlayer, enemy, context = {}) {
    void enemy;

    const equippedSkills = getEquippedSkillObjects(targetPlayer);
    let bonus = 0;

    equippedSkills.forEach(skill => {
        const effects = skill.effects || {};

        if (skill.id === 'first_attack' && effects.earlyWinRateBonus) {
            bonus += effects.earlyWinRateBonus;
        }

        if (skill.id === 'long_rally' && effects.longRallyWinRateBonus) {
            bonus += effects.longRallyWinRateBonus;
        }

        if (skill.id === 'comeback_mind' && effects.comebackWinRateBonus && context.isDisadvantage) {
            bonus += effects.comebackWinRateBonus;
        }

        if (skill.id === 'critical_thinking' && effects.criticalRate && Math.random() < effects.criticalRate) {
            bonus += 0.05;
        }
    });

    return bonus;
}

function applySkillMatchupAdjustment(matchupBonus, targetPlayer) {
    const equippedSkills = getEquippedSkillObjects(targetPlayer);
    const styleAdaptSkill = equippedSkills.find(skill => skill.id === 'style_adapt');

    if (!styleAdaptSkill || matchupBonus >= 0) {
        return matchupBonus;
    }

    const effects = styleAdaptSkill.effects || {};
    const reduceRate = effects.disadvantageReduceRate || 0;
    return matchupBonus * (1 - reduceRate);
}

function applySkillDebuffsToEnemy(enemy, targetPlayer) {
    const equippedSkills = getEquippedSkillObjects(targetPlayer);
    let enemySpdRate = 0;

    equippedSkills.forEach(skill => {
        const effects = skill.effects || {};
        enemySpdRate += effects.enemySpdRate || 0;
    });

    return {
        ...enemy,
        spd: Math.round(enemy.spd * (1 + enemySpdRate))
    };
}

function generateSkillBattleLogs(targetPlayer, context = {}) {
    const equippedSkills = getEquippedSkillObjects(targetPlayer);
    const logs = [];

    equippedSkills.forEach(skill => {
        switch (skill.id) {
            case 'fast_drive':
                logs.push('高速ドライブで先に仕掛けた。');
                break;
            case 'smash_boost':
                logs.push('スマッシュ強化で決定打が冴えた。');
                break;
            case 'rush_mode':
                logs.push('連打モードで攻撃の手数を増やした。');
                break;
            case 'first_attack':
                logs.push('先手必勝で立ち上がりを制した。');
                break;
            case 'attack_focus':
                logs.push('攻撃集中で打球の質が上がった。');
                break;
            case 'iron_counter':
                logs.push('鉄壁カウンターで反撃の形を作った。');
                break;
            case 'precise_block':
                logs.push('精密ブロックでコースを封じた。');
                break;
            case 'quick_reaction':
                logs.push('反射神経強化で対応速度が上がった。');
                break;
            case 'counter_smash':
                if (context.isDisadvantage) {
                    logs.push('一撃返しが発動し、不利展開を押し返した。');
                }
                break;
            case 'trap_counter':
                logs.push('誘導反撃で相手のミスを引き出した。');
                break;
            case 'endurance':
                logs.push('粘り強化で後半も動きが落ちなかった。');
                break;
            case 'full_defense':
                logs.push('守備極振りで失点を抑えた。');
                break;
            case 'long_rally':
                logs.push('ラリー延長で長期戦を有利に運んだ。');
                break;
            case 'shield':
                logs.push('耐久シールドで強打をしのいだ。');
                break;
            case 'rhythm_break':
                logs.push('リズム破壊で相手のテンポを崩した。');
                break;
            case 'focus':
                logs.push('集中力で安定したプレーを続けた。');
                break;
            case 'stable_action':
                logs.push('安定行動でプレーのブレを抑えた。');
                break;
            case 'critical_thinking':
                logs.push('クリティカル思考で勝負所を突いた。');
                break;
            case 'comeback_mind':
                if (context.isDisadvantage) {
                    logs.push('逆転思考が発動し、劣勢から巻き返した。');
                }
                break;
            case 'style_adapt':
                if (context.isDisadvantage) {
                    logs.push('戦型適応により、不利相性を軽減した');
                }
                break;
            default:
                break;
        }
    });

    return logs;
}

function calculateBattleSkillBonus(targetPlayer, context = {}) {
    // Phase7(先行)では未実装: バトルイベント補正はまだ適用しない
    void targetPlayer;
    void context;
    return 0;
}

function applyEnemyDebuffFromSkills(owner, enemyEffective, activationContext) {
    void activationContext;
    return applySkillDebuffsToEnemy(enemyEffective, owner);
}

function applyDisadvantageReduction(targetPlayer, matchupModifier, context) {
    void context;
    return applySkillMatchupAdjustment(matchupModifier, targetPlayer);
}

function generateSkillLog(targetPlayer, context) {
    return generateSkillBattleLogs(targetPlayer, context);
}

function getStyleIdByName(styleName) {
    return styles.findIndex(style => style.name === styleName);
}

function getRivalById(rivalId) {
    return rivals.find(rival => rival.id === rivalId) || null;
}

function getTacticById(tacticId) {
    return tactics.find(tactic => tactic.id === tacticId) || null;
}

function applyTacticStatusBonus(character, tacticId) {
    const tactic = getTacticById(tacticId);

    if (!tactic) {
        return { ...character };
    }

    const effects = tactic.effects || {};

    return {
        ...character,
        atk: Math.round(character.atk * (1 + (effects.atkRate || 0))),
        def: Math.round(character.def * (1 + (effects.defRate || 0))),
        spd: Math.round(character.spd * (1 + (effects.spdRate || 0))),
        tec: Math.round(character.tec * (1 + (effects.tecRate || 0))),
        sta: Math.round(character.sta * (1 + (effects.staRate || 0)))
    };
}

function applyTacticMatchupAdjustment(matchupBonus, tacticId) {
    const tactic = getTacticById(tacticId);

    if (!tactic) {
        return matchupBonus;
    }

    const effects = tactic.effects || {};
    let adjustedBonus = matchupBonus;

    if (matchupBonus < 0 && effects.disadvantageReduceRate) {
        adjustedBonus = matchupBonus * (1 - effects.disadvantageReduceRate);
    }

    if (matchupBonus > 0 && effects.advantageReduceRate) {
        adjustedBonus = matchupBonus * (1 - effects.advantageReduceRate);
    }

    return adjustedBonus;
}

function calculateTacticWinRateBonus(tacticId) {
    const tactic = getTacticById(tacticId);
    if (!tactic) {
        return 0;
    }

    const effects = tactic.effects || {};
    let bonus = 0;

    bonus += effects.earlyWinRateBonus || 0;
    bonus += effects.criticalRate || 0;

    if (effects.mistakeRate) {
        bonus -= effects.mistakeRate;
    }

    return bonus;
}

function generateTacticLog(tacticId) {
    const tactic = getTacticById(tacticId);
    if (!tactic) {
        return [];
    }

    return [`作戦「${tactic.name}」を選択した。${tactic.description}`];
}

function generateModeStartLog(mode, enemy) {
    if (mode === 'rival') {
        return [
            'ライバル戦を開始した。',
            `相手は「${enemy.name}」。`,
            enemy.description || `${styles[enemy.style].name}の対策が重要だ。`
        ];
    }

    if (mode === 'tournament') {
        return ['大会モードの試合を開始した。', '3連戦を勝ち抜いて優勝を狙う。'];
    }

    return ['練習試合を開始した。', 'ランダムな相手と対戦する。'];
}

function scaleUnitStats(unit, scaleRate) {
    return {
        ...unit,
        atk: Math.max(8, Math.round(unit.atk * scaleRate)),
        def: Math.max(8, Math.round(unit.def * scaleRate)),
        spd: Math.max(8, Math.round(unit.spd * scaleRate)),
        tec: Math.max(8, Math.round(unit.tec * scaleRate)),
        sta: Math.max(8, Math.round(unit.sta * scaleRate))
    };
}

function scaleEnemyToTargetPower(enemy, targetPower) {
    const currentPower = calculatePower(enemy);
    if (currentPower <= 0 || targetPower <= 0) {
        return enemy;
    }

    const scaleRate = targetPower / currentPower;
    return scaleUnitStats(enemy, scaleRate);
}

function generatePracticeEnemy(targetPlayer) {
    return createCpuOpponent(targetPlayer);
}

function generateRivalEnemy(targetPlayer, rivalId) {
    const rival = getRivalById(rivalId);

    if (!rival) {
        return generatePracticeEnemy(targetPlayer);
    }

    const styleId = getStyleIdByName(rival.styleName);
    const baseEnemy = createCpuOpponent(targetPlayer);
    const targetPower = calculatePower(targetPlayer) * 1.05;
    const enemy = scaleEnemyToTargetPower({
        ...baseEnemy,
        style: styleId >= 0 ? styleId : baseEnemy.style
    }, targetPower);

    enemy.name = rival.name;
    enemy.mainType = rival.mainType;
    enemy.description = rival.description;

    return enemy;
}

function createEnemyForMode(mode, rivalId = null, targetPlayer = player) {
    if (mode === 'rival') {
        return generateRivalEnemy(targetPlayer, rivalId);
    }

    return generatePracticeEnemy(targetPlayer);
}

function calculateExpReward(mode, result, options = {}) {
    if (mode === 'practice') {
        return result === 'win' ? 30 : 15;
    }

    if (mode === 'rival') {
        return result === 'win' ? 45 : 20;
    }

    if (mode === 'tournament') {
        if (options.isChampion) {
            return 85;
        }
        return result === 'win' ? 35 : 15;
    }

    return result === 'win' ? 30 : 15;
}

function simulateBattleWithOptions(options = {}) {
    const mode = options.mode || 'practice';
    const tacticId = options.tacticId || selectedTacticId || 'first_attack';
    const rivalId = options.rivalId || null;
    const roundIndex = Number.isFinite(options.roundIndex) ? options.roundIndex : null;
    const enemy = options.enemy || createEnemyForMode(mode, rivalId, player);

    const baseCategoryModifier = calcBaseCategoryModifier(player.style, enemy.style);
    const sameCategoryModifier = calcSameCategoryModifier(player.style, enemy.style);
    const rawMatchupModifier = baseCategoryModifier + sameCategoryModifier;

    const context = {
        isDisadvantage: rawMatchupModifier < 0,
        mode,
        rivalId,
        tacticId
    };

    const skillAdjustedMatchup = applySkillMatchupAdjustment(rawMatchupModifier, player);
    const adjustedMatchupModifier = applyTacticMatchupAdjustment(skillAdjustedMatchup, tacticId);
    const debuffedCpu = applySkillDebuffsToEnemy(enemy, player);

    const skillEffectivePlayer = applySkillStatusBonus(player);
    const effectivePlayer = applyTacticStatusBonus(skillEffectivePlayer, tacticId);
    const effectiveCpu = applySkillStatusBonus(debuffedCpu);

    const playerPower = calculatePower(effectivePlayer);
    const cpuPower = calculatePower(effectiveCpu);
    const baseRate = playerPower / (playerPower + cpuPower);

    const skillWinRateBonus = calculateSkillWinRateBonus(player, debuffedCpu, context);
    const skillBattleBonus = calculateBattleSkillBonus(player, context);
    const tacticWinRateBonus = calculateTacticWinRateBonus(tacticId);

    const finalWinRate = clampWinRate(
        baseRate + adjustedMatchupModifier + skillWinRateBonus + skillBattleBonus + tacticWinRateBonus
    );
    const isPlayerWin = Math.random() < finalWinRate;

    const battleLines = [
        ...generateModeStartLog(mode, enemy),
        ...(roundIndex !== null ? [`大会 第${roundIndex + 1}試合`] : []),
        ...generateTacticLog(tacticId),
        ...buildBattleLogLines(isPlayerWin, player.style, enemy.style, generateSkillBattleLogs(player, context))
    ];

    return {
        mode,
        tacticId,
        rivalId,
        cpu: enemy,
        baseCategoryModifier,
        sameCategoryModifier,
        adjustedMatchupModifier,
        skillWinRateBonus,
        skillBattleBonus,
        tacticWinRateBonus,
        playerPower,
        cpuPower,
        finalWinRate,
        isPlayerWin,
        battleLines,
        roundIndex,
        result: isPlayerWin ? 'win' : 'lose',
        log: battleLines
    };
}

function simulateBattle() {
    return simulateBattleWithOptions({
        mode: 'practice',
        tacticId: selectedTacticId
    });
}

// ============================================================
// UI 更新関数
// ============================================================

// プレイヤー情報を表示
function updatePlayerInfo() {
    document.getElementById('playerName').textContent = player.name;
    document.getElementById('playerLevel').textContent = `Lv ${player.level}`;

    const expElement = document.getElementById('playerExp');
    if (expElement) {
        expElement.textContent = `EXP: ${player.exp} / 使用可: ${player.usableExp}`;
    }

    const equipInfoElement = document.getElementById('equipSlotsInfo');
    if (equipInfoElement) {
        ensurePlayerEquippedSkills(player);
        equipInfoElement.textContent = `装備中 ${player.equippedSkills.length} / ${getMaxEquipSlots(player.level)}`;
    }
}

// ステータスを表示・更新
function updateStats() {
    document.getElementById('statAtk').textContent = player.atk;
    document.getElementById('statDef').textContent = player.def;
    document.getElementById('statSpd').textContent = player.spd;
    document.getElementById('statTec').textContent = player.tec;
    document.getElementById('statSta').textContent = player.sta;

    const maxStat = 50;
    document.getElementById('atkBar').style.width = (player.atk / maxStat * 100) + '%';
    document.getElementById('defBar').style.width = (player.def / maxStat * 100) + '%';
    document.getElementById('spdBar').style.width = (player.spd / maxStat * 100) + '%';
    document.getElementById('tecBar').style.width = (player.tec / maxStat * 100) + '%';
    document.getElementById('staBar').style.width = (player.sta / maxStat * 100) + '%';
}

// ============================================================
// 戦型情報を表示
function updateStyleInfo() {
    if (player.style === null) {
        document.getElementById('styleName').textContent = '戦型を選択してください';
        document.getElementById('styleDescription').textContent = '複数の戦型から一つを選んでください';
    } else {
        const style = styles[player.style];
        document.getElementById('styleName').textContent = style.name;
        document.getElementById('styleDescription').textContent = style.description;
    }

    const locked = isSetupComplete();
    const lockBadge = document.getElementById('styleLockBadge');
    if (lockBadge) {
        lockBadge.style.display = locked ? 'inline-block' : 'none';
    }

    const styleButtons = document.querySelectorAll('.style-btn');
    styleButtons.forEach(btn => {
        const btnStyle = Number(btn.getAttribute('data-style'));
        btn.classList.toggle('active', btnStyle === player.style);
        btn.disabled = locked;
    });
}

function renderOwnedSkills() {
    const ownedListElement = document.getElementById('ownedSkillList');
    if (!ownedListElement) {
        return;
    }

    const ownedSkills = getOwnedSkills(player);
    if (ownedSkills.length === 0) {
        ownedListElement.innerHTML = '<div class="skill-empty">まだスキルカードを持っていません</div>';
        return;
    }

    const itemsHtml = ownedSkills
        .map(skill => {
            const equipped = isSkillEquipped(player, skill.id);
            const maxSlots = getMaxEquipSlots(player.level);
            const canEquip = !equipped && player.equippedSkills.length < maxSlots;

            return `
                <div class="skill-card ${equipped ? 'equipped' : ''}">
                    <div class="skill-title-row">
                        <span class="skill-name">${skill.name}</span>
                        <span class="skill-category">${skill.category}</span>
                    </div>
                    <div class="skill-description">${skill.description}</div>
                    <div class="skill-meta">発動条件: ${skill.trigger}</div>
                    <div class="skill-meta">演出タグ: ${skill.animationTag}</div>
                    ${
                        equipped
                            ? '<div class="equipped-label">装備中</div>'
                            : `<button class="skill-action-btn equip-skill-btn" data-skill-id="${skill.id}" ${canEquip ? '' : 'disabled'}>装備する</button>`
                    }
                </div>
            `;
        })
        .join('');

    ownedListElement.innerHTML = itemsHtml;
}

// ============================================================
// Phase10 キャラクターアニメーション
// ============================================================

let lastEnemyForAnimation = null;

function getCharacterClassByStyle(styleName) {
    switch (styleName) {
        case '前陣速攻型':       return 'style-front-fast-attack';
        case 'オールフォア型':   return 'style-all-fore';
        case 'パワー両ハンド型': return 'style-power-both-hand';
        case 'ブロック＆カウンター型': return 'style-block-counter';
        case '一撃カウンター型': return 'style-one-shot-counter';
        case 'オールラウンド型': return 'style-all-round';
        case 'ペン粒型':         return 'style-pips';
        case 'カットマン型':     return 'style-chopper';
        case '異質攻守型':       return 'style-trickster';
        default:                 return 'style-all-round';
    }
}

function renderCharacters(enemy) {
    const playerCharacter = document.getElementById('player-character');
    const enemyCharacter = document.getElementById('enemy-character');
    const playerLabel = document.getElementById('player-character-label');
    const enemyLabel = document.getElementById('enemy-character-label');

    if (!playerCharacter || !enemyCharacter) {
        return;
    }

    const resolvedEnemy = enemy || lastEnemyForAnimation;

    const playerStyleName = player.style !== null ? styles[player.style].name : null;
    const enemyStyleName = resolvedEnemy?.style != null ? styles[resolvedEnemy.style].name : null;

    const playerStyleClass = getCharacterClassByStyle(playerStyleName);
    const enemyStyleClass = getCharacterClassByStyle(enemyStyleName);

    playerCharacter.className = `tt-character player-character ${playerStyleClass}`;
    enemyCharacter.className = `tt-character enemy-character ${enemyStyleClass}`;

    if (playerLabel) {
        playerLabel.textContent = playerStyleName || '未選択';
    }
    if (enemyLabel) {
        enemyLabel.textContent = enemyStyleName || 'CPU';
    }

    if (enemy) {
        lastEnemyForAnimation = enemy;
    }
}

function clearCharacterAnimations() {
    const playerCharacter = document.getElementById('player-character');
    const enemyCharacter = document.getElementById('enemy-character');
    const ball = document.getElementById('battle-ball');

    const animationClasses = [
        'anim-attack', 'anim-defense', 'anim-counter',
        'anim-skill', 'anim-win', 'anim-lose'
    ];

    if (playerCharacter) {
        playerCharacter.classList.remove(...animationClasses);
    }
    if (enemyCharacter) {
        enemyCharacter.classList.remove(...animationClasses);
    }
    if (ball) {
        ball.classList.remove('anim-to-enemy', 'anim-to-player');
    }
}

function playCharacterAnimation(eventType, actor) {
    const resolvedActor = actor || 'player';
    clearCharacterAnimations();

    const playerCharacter = document.getElementById('player-character');
    const enemyCharacter = document.getElementById('enemy-character');
    const ball = document.getElementById('battle-ball');
    const message = document.getElementById('battle-animation-message');

    const target = resolvedActor === 'enemy' ? enemyCharacter : playerCharacter;
    if (!target) {
        return;
    }

    if (eventType === 'attack' || eventType === 'drive' || eventType === 'smash') {
        target.classList.add('anim-attack');
        if (ball) {
            ball.classList.add(resolvedActor === 'player' ? 'anim-to-enemy' : 'anim-to-player');
        }
        if (message) {
            message.textContent = resolvedActor === 'player' ? 'プレイヤーが攻めた！' : 'CPUが攻めた！';
        }
    } else if (eventType === 'defense' || eventType === 'block' || eventType === 'cut') {
        target.classList.add('anim-defense');
        if (message) {
            message.textContent = resolvedActor === 'player' ? 'プレイヤーが守った！' : 'CPUが守った！';
        }
    } else if (eventType === 'counter') {
        target.classList.add('anim-counter');
        if (ball) {
            ball.classList.add(resolvedActor === 'player' ? 'anim-to-enemy' : 'anim-to-player');
        }
        if (message) {
            message.textContent = resolvedActor === 'player' ? 'カウンター成功！' : 'CPUのカウンター！';
        }
    } else if (eventType === 'skill') {
        target.classList.add('anim-skill');
        if (message) {
            message.textContent = resolvedActor === 'player' ? 'スキル発動！' : 'CPUのスキル発動！';
        }
    } else if (eventType === 'win') {
        target.classList.add('anim-win');
        if (message) {
            message.textContent = resolvedActor === 'player' ? '勝利！' : 'CPU勝利';
        }
    } else if (eventType === 'lose') {
        target.classList.add('anim-lose');
        if (message) {
            message.textContent = resolvedActor === 'player' ? '敗北...' : 'CPUが崩れた';
        }
    }

    setTimeout(clearCharacterAnimations, 450);
}

function inferAnimationEventFromLog(logText) {
    if (!logText) {
        return 'rally';
    }

    if (
        logText.includes('ドライブ') ||
        logText.includes('スマッシュ') ||
        logText.includes('攻め') ||
        logText.includes('強打')
    ) {
        return 'attack';
    }

    if (
        logText.includes('ブロック') ||
        logText.includes('守り') ||
        logText.includes('カット') ||
        logText.includes('しのいだ')
    ) {
        return 'defense';
    }

    if (
        logText.includes('カウンター') ||
        logText.includes('反撃')
    ) {
        return 'counter';
    }

    if (
        logText.includes('スキル') ||
        logText.includes('発動') ||
        logText.includes('集中力') ||
        logText.includes('戦型適応')
    ) {
        return 'skill';
    }

    if (
        logText.includes('勝利') ||
        logText.includes('勝った') ||
        logText.includes('優勝')
    ) {
        return 'win';
    }

    if (
        logText.includes('敗北') ||
        logText.includes('負け')
    ) {
        return 'lose';
    }

    return 'rally';
}

function playBattleLogAnimation(logs, result) {
    if (!Array.isArray(logs) || logs.length === 0) {
        return;
    }

    let index = 0;

    function playNext() {
        if (index >= logs.length) {
            if (result === 'win') {
                playCharacterAnimation('win', 'player');
            } else if (result === 'lose') {
                playCharacterAnimation('lose', 'player');
            }
            return;
        }

        const logText = logs[index];
        const eventType = inferAnimationEventFromLog(logText);

        if (eventType !== 'rally') {
            playCharacterAnimation(eventType, 'player');
        }

        index += 1;
        setTimeout(playNext, 600);
    }

    // renderAll() が同期的に className を上書きした後でアニメを開始する
    setTimeout(playNext, 0);
}

function renderTrainingScreen() {
    const trainingPlayerName = document.getElementById('trainingPlayerName');
    if (trainingPlayerName) {
        trainingPlayerName.textContent = player.name;
    }

    const trainingStyleName = document.getElementById('trainingStyleName');
    if (trainingStyleName) {
        trainingStyleName.textContent = player.style !== null ? styles[player.style].name : '未選択';
    }

    const trainingPlayerExp = document.getElementById('trainingPlayerExp');
    if (trainingPlayerExp) {
        trainingPlayerExp.textContent = `${player.exp} / 使用可: ${player.usableExp}`;
    }

    const maxStat = 50;
    const statKeys = ['Atk', 'Def', 'Spd', 'Tec', 'Sta'];
    statKeys.forEach(label => {
        const key = label.toLowerCase();
        const valEl = document.getElementById(`trainingStat${label}`);
        if (valEl) {
            valEl.textContent = player[key];
        }
        const barEl = document.getElementById(`training${label}Bar`);
        if (barEl) {
            barEl.style.width = Math.min(100, (player[key] / maxStat * 100)) + '%';
        }
    });
}

function renderDataScreen() {
    const dataPlayerName = document.getElementById('dataPlayerName');
    if (dataPlayerName) {
        dataPlayerName.textContent = player.name;
    }

    const dataStyleName = document.getElementById('dataStyleName');
    if (dataStyleName) {
        dataStyleName.textContent = player.style !== null ? styles[player.style].name : '未選択';
    }

    const dataPlayerLevel = document.getElementById('dataPlayerLevel');
    if (dataPlayerLevel) {
        dataPlayerLevel.textContent = `Lv ${player.level}`;
    }

    const dataPlayerExp = document.getElementById('dataPlayerExp');
    if (dataPlayerExp) {
        dataPlayerExp.textContent = `${player.exp} (使用可: ${player.usableExp})`;
    }

    const maxStat = 50;
    const statKeys = ['Atk', 'Def', 'Spd', 'Tec', 'Sta'];
    statKeys.forEach(label => {
        const key = label.toLowerCase();
        const valEl = document.getElementById(`dataStat${label}`);
        if (valEl) {
            valEl.textContent = player[key];
        }
        const barEl = document.getElementById(`data${label}Bar`);
        if (barEl) {
            barEl.style.width = (player[key] / maxStat * 100) + '%';
        }
    });

    const totalMatches = (player.wins || 0) + (player.losses || 0);
    const dataMatches = document.getElementById('dataMatches');
    if (dataMatches) {
        dataMatches.textContent = totalMatches;
    }

    const dataWins = document.getElementById('dataWins');
    if (dataWins) {
        dataWins.textContent = player.wins || 0;
    }

    const dataLosses = document.getElementById('dataLosses');
    if (dataLosses) {
        dataLosses.textContent = player.losses || 0;
    }

    const dataWinRate = document.getElementById('dataWinRate');
    if (dataWinRate) {
        if (totalMatches > 0) {
            const rate = Math.round((player.wins || 0) / totalMatches * 100);
            dataWinRate.textContent = `${rate}%`;
        } else {
            dataWinRate.textContent = '-';
        }
    }

    const dataOwnedSkillList = document.getElementById('dataOwnedSkillList');
    if (dataOwnedSkillList) {
        const ownedSkills = getOwnedSkills(player);
        if (ownedSkills.length === 0) {
            dataOwnedSkillList.innerHTML = '<div class="skill-empty">まだスキルカードを持っていません</div>';
        } else {
            dataOwnedSkillList.innerHTML = ownedSkills
                .map(skill => {
                    const equipped = isSkillEquipped(player, skill.id);
                    return `
                        <div class="skill-card ${equipped ? 'equipped' : ''}">
                            <div class="skill-title-row">
                                <span class="skill-name">${skill.name}</span>
                                <span class="skill-category">${skill.category}</span>
                            </div>
                            <div class="skill-description">${skill.description}</div>
                            ${equipped ? '<div class="equipped-label">装備中</div>' : ''}
                        </div>
                    `;
                })
                .join('');
        }
    }

    const dataEquippedSkillList = document.getElementById('dataEquippedSkillList');
    if (dataEquippedSkillList) {
        const equippedSkills = getEquippedSkills(player);
        if (equippedSkills.length === 0) {
            dataEquippedSkillList.innerHTML = '<div class="skill-empty">装備中スキルはありません。</div>';
        } else {
            dataEquippedSkillList.innerHTML = equippedSkills
                .map(skill => `
                    <div class="skill-card equipped">
                        <div class="skill-title-row">
                            <span class="skill-name">${skill.name}</span>
                            <span class="skill-category">${skill.category}</span>
                        </div>
                        <div class="skill-description">${skill.description}</div>
                    </div>
                `)
                .join('');
        }
    }
}

function renderAll() {
    updatePlayerInfo();
    updateStats();
    updateStyleInfo();
    renderOwnedSkills();
    renderEquippedSkills();
    renderTactics();
    renderRivals();
    updateCurrentModeLabel(currentBattleMode);
    renderCharacters();
    renderSettings();
    renderTrainingScreen();
    renderDataScreen();
}

function renderSettings() {
    const nameEl = document.getElementById('settingsPlayerName');
    if (nameEl) {
        nameEl.textContent = player.name;
    }

    const styleEl = document.getElementById('settingsStyleName');
    if (styleEl) {
        styleEl.textContent = player.style !== null ? styles[player.style].name : '未選択';
    }
}

function renderEquippedSkills() {
    const equippedListElement = document.getElementById('equippedSkillList');
    if (!equippedListElement) {
        return;
    }

    const equippedSkills = getEquippedSkills(player);
    const equipInfoElement = document.getElementById('equipSlotsInfo');
    if (equipInfoElement) {
        equipInfoElement.textContent = `装備中 ${equippedSkills.length} / ${getMaxEquipSlots(player.level)}`;
    }

    if (equippedSkills.length === 0) {
        equippedListElement.innerHTML = '<div class="skill-empty">装備中スキルはありません。</div>';
        return;
    }

    const itemsHtml = equippedSkills
        .map(skill => {
            return `
                <div class="skill-card equipped">
                    <div class="skill-title-row">
                        <span class="skill-name">${skill.name}</span>
                        <span class="skill-category">${skill.category}</span>
                    </div>
                    <div class="skill-description">${skill.description}</div>
                    <button class="skill-action-btn unequip-skill-btn" data-skill-id="${skill.id}">解除する</button>
                </div>
            `;
        })
        .join('');

    equippedListElement.innerHTML = itemsHtml;
}

function updateSkillUI() {
    renderAll();
}

// ============================================================
// メッセージログ関数
// ============================================================

function addLog(message, type = 'info') {
    const logContainer = document.getElementById('messageLog');
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    entry.textContent = `[${time}] ${message}`;
    logContainer.insertBefore(entry, logContainer.firstChild);

    while (logContainer.children.length > 20) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

function clearBattleLog() {
    const battleLogContainer = document.getElementById('battleLog');
    battleLogContainer.innerHTML = '';
}

function addBattleLog(message) {
    const battleLogContainer = document.getElementById('battleLog');
    const entry = document.createElement('div');
    entry.className = 'battle-log-entry';
    entry.textContent = message;
    battleLogContainer.appendChild(entry);
}

function renderBattleLog(lines) {
    clearBattleLog();
    lines.forEach(line => addBattleLog(line));
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function clampWinRate(winRate) {
    return clamp(winRate, 0.1, 0.9);
}

function calcAttackPower(unit) {
    return unit.atk * 1.2 + unit.spd * 0.7 + unit.tec * 0.8;
}

function calcDefensePower(unit) {
    return unit.def * 1.2 + unit.sta * 0.8 + unit.tec * 0.7;
}

function calcFlowPower(unit) {
    return unit.spd * 1.0 + unit.tec * 0.9 + unit.sta * 0.4;
}

function calcOverallPower(unit) {
    return calcAttackPower(unit) + calcDefensePower(unit) + calcFlowPower(unit);
}

function calculatePower(unit) {
    return calcOverallPower(unit);
}

function getHalfModifierScale(styleId, ownCategory, opponentCategory) {
    if (styleId === 0 && ownCategory === '攻撃系' && (opponentCategory === '守備系' || opponentCategory === 'カウンター系')) {
        return 0.5;
    }

    if (styleId === 5 && ownCategory === 'カウンター系' && (opponentCategory === '攻撃系' || opponentCategory === '守備系')) {
        return 0.5;
    }

    if (styleId === 8 && ownCategory === '守備系' && (opponentCategory === 'カウンター系' || opponentCategory === '攻撃系')) {
        return 0.5;
    }

    return 1;
}

function calcBaseCategoryModifier(playerStyleId, cpuStyleId) {
    const playerCategory = styles[playerStyleId].category;
    const cpuCategory = styles[cpuStyleId].category;

    if (playerCategory === cpuCategory) {
        return 0;
    }

    const playerHasAdvantage = baseCategoryAdvantage[playerCategory] === cpuCategory;
    const sign = playerHasAdvantage ? 1 : -1;
    let modifier = 0.15;

    const playerScale = getHalfModifierScale(playerStyleId, playerCategory, cpuCategory);
    const cpuScale = getHalfModifierScale(cpuStyleId, cpuCategory, playerCategory);
    modifier *= playerScale * cpuScale;

    return sign * modifier;
}

function calcSameCategoryModifier(playerStyleId, cpuStyleId) {
    if (styles[playerStyleId].category !== styles[cpuStyleId].category) {
        return 0;
    }

    if (playerStyleId === cpuStyleId) {
        return 0;
    }

    if (sameCategoryAdvantage[playerStyleId] === cpuStyleId) {
        return 0.08;
    }

    return -0.08;
}

function createCpuOpponent(targetPlayer = player) {
    const styleId = randomInt(0, styles.length - 1);
    return {
        name: `CPU-${randomInt(100, 999)}`,
        style: styleId,
        atk: randomInt(Math.max(8, targetPlayer.atk - 3), targetPlayer.atk + 3),
        def: randomInt(Math.max(8, targetPlayer.def - 3), targetPlayer.def + 3),
        spd: randomInt(Math.max(8, targetPlayer.spd - 3), targetPlayer.spd + 3),
        tec: randomInt(Math.max(8, targetPlayer.tec - 3), targetPlayer.tec + 3),
        sta: randomInt(Math.max(8, targetPlayer.sta - 3), targetPlayer.sta + 3),
        skills: [],
        equippedSkills: []
    };
}

// ============================================================
// 経験値システム（Phase3継続 + Phase4連携）
// ============================================================

function calcBattleExp(isPlayerWin, baseCategoryModifier, sameCategoryModifier) {
    let baseExp = isPlayerWin ? 100 : 30;

    const totalModifier = baseCategoryModifier + sameCategoryModifier;
    const modifierBonus = totalModifier > 0 ? 1.1 : (totalModifier < 0 ? 0.9 : 1.0);

    return Math.floor(baseExp * modifierBonus);
}

function awardExp(earnedExp) {
    player.exp += earnedExp;
    player.usableExp += earnedExp;
}

function simulateGamePoints(perPointRate, firstServerIsPlayer, playerStyleName, cpuStyleName) {
    const actions = ['サーブ', 'レシーブ', 'ドライブ', 'ブロック', 'カウンター', 'カット', 'スマッシュ'];
    const momentumWords = ['主導権を握る', 'ラリーを制する', '粘り勝つ', 'ミスを誘う', '角度を突く'];
    const lines = [];
    let playerScore = 0;
    let cpuScore = 0;
    let totalPointsPlayed = 0;
    let deuceNotified = false;

    const firstServerName = firstServerIsPlayer ? 'プレイヤー' : 'CPU';
    lines.push(`${firstServerName}のサーブから開始！`);

    while (true) {
        const isDeuce = playerScore >= 10 && cpuScore >= 10;

        // Determine current server:
        // Normal play: serve switches every 2 points based on serve group number.
        // Deuce (both >= 10): serve switches every 1 point. Deuce always begins at
        // totalPointsPlayed=20, so (totalPointsPlayed - 20) counts extra deuce points,
        // each with their own serve group to preserve the every-1-point rotation.
        const serveGroup = isDeuce
            ? (totalPointsPlayed - 20)
            : Math.floor(totalPointsPlayed / 2);
        const currentServerIsPlayer = firstServerIsPlayer ? (serveGroup % 2 === 0) : (serveGroup % 2 !== 0);

        if (isDeuce && !deuceNotified) {
            lines.push(`【デュース】${playerScore}-${cpuScore} — 2点差をつけた方の勝利！`);
            deuceNotified = true;
        }

        const playerWinsPoint = Math.random() < perPointRate;
        if (playerWinsPoint) {
            playerScore++;
        } else {
            cpuScore++;
        }
        totalPointsPlayed++;

        const action = actions[randomInt(0, actions.length - 1)];
        const momentum = momentumWords[randomInt(0, momentumWords.length - 1)];
        const pointWinner = playerWinsPoint ? 'プレイヤー' : 'CPU';
        const styleName = playerWinsPoint ? playerStyleName : cpuStyleName;
        const serverName = currentServerIsPlayer ? 'プレイヤー' : 'CPU';

        lines.push(`[${playerScore}-${cpuScore}] ${serverName}サーブ: ${styleName}の${action}。${pointWinner}が${momentum}。`);

        if (Math.max(playerScore, cpuScore) >= 11 && Math.abs(playerScore - cpuScore) >= 2) {
            break;
        }
    }

    return { lines, playerScore, cpuScore };
}

function buildBattleLogLines(isPlayerWin, playerStyleId, cpuStyleId, skillLogLines) {
    const playerStyleName = styles[playerStyleId].name;
    const cpuStyleName = styles[cpuStyleId].name;
    // Per-point win rates are biased so that the simulated game usually produces
    // the same winner as the pre-determined match outcome (isPlayerWin).
    // 0.62 gives the intended winner ~80% of individual simulated games,
    // meaning the do-while loop below typically resolves in 1-2 iterations.
    const perPointRate = isPlayerWin ? 0.62 : 0.38;
    const firstServerIsPlayer = Math.random() < 0.5;

    let result;
    let attempts = 0;
    do {
        result = simulateGamePoints(perPointRate, firstServerIsPlayer, playerStyleName, cpuStyleName);
        attempts++;
    } while ((result.playerScore > result.cpuScore) !== isPlayerWin && attempts < 20);

    const lines = result.lines;

    skillLogLines.forEach(log => {
        lines.push(`スキル: ${log}`);
    });

    const finalScore = `${result.playerScore}-${result.cpuScore}`;
    lines.push(isPlayerWin
        ? `最終スコア ${finalScore}: プレイヤーの勝利！`
        : `最終スコア ${finalScore}: CPUの勝利...`);
    return lines;
}

function updateBattleResultView(cpu, playerPower, cpuPower, winRate, isPlayerWin) {
    document.getElementById('cpuInfo').textContent = `${cpu.name}（${styles[cpu.style].name}）`;
    document.getElementById('playerPower').textContent = playerPower.toFixed(1);
    document.getElementById('cpuPower').textContent = cpuPower.toFixed(1);
    document.getElementById('winRate').textContent = `${(winRate * 100).toFixed(1)}%`;

    const resultElement = document.getElementById('battleResult');
    resultElement.classList.remove('result-win', 'result-lose');
    resultElement.textContent = isPlayerWin ? '勝利' : '敗北';
    resultElement.classList.add(isPlayerWin ? 'result-win' : 'result-lose');
}

function updateCurrentModeLabel(mode) {
    currentBattleMode = mode;
    const modeLabel = document.getElementById('currentModeLabel');
    if (!modeLabel) {
        return;
    }
    modeLabel.textContent = `現在モード: ${gameModes[mode] || gameModes.practice}`;
}

function renderTactics() {
    const select = document.getElementById('tacticSelect');
    const description = document.getElementById('tacticDescription');

    if (!select) {
        return;
    }

    select.innerHTML = tactics.map(tactic => {
        const selected = tactic.id === selectedTacticId ? 'selected' : '';
        return `<option value="${tactic.id}" ${selected}>${tactic.name}</option>`;
    }).join('');

    const currentTactic = getTacticById(selectedTacticId);
    if (description && currentTactic) {
        description.textContent = currentTactic.description;
    }
}

function renderRivals() {
    const container = document.getElementById('rivalList');
    if (!container) {
        return;
    }

    container.innerHTML = rivals.map(rival => {
        return `
            <div class="rival-card">
                <h4>${rival.name}</h4>
                <div class="rival-style">戦型: ${rival.styleName}</div>
                <div class="rival-description">${rival.description}</div>
                <button class="rival-battle-btn" data-rival-id="${rival.id}">挑戦する</button>
            </div>
        `;
    }).join('');
}

function applyMatchResult(result) {
    const expGained = calculateExpReward(result.mode, result.result, result);

    if (result.result === 'win') {
        player.wins += 1;
    } else {
        player.losses += 1;
    }

    awardExp(expGained);
    updateBattleResultView(result.cpu, result.playerPower, result.cpuPower, result.finalWinRate, result.isPlayerWin);
    renderBattleLog(result.battleLines);
    renderCharacters(result.cpu);
    playBattleLogAnimation(result.battleLines, result.result);

    const tactic = getTacticById(result.tacticId);
    const tacticName = tactic ? tactic.name : '未設定';
    addLog(
        `${gameModes[result.mode] || gameModes.practice}: ${result.isPlayerWin ? '勝利' : '敗北'} | 作戦: ${tacticName} | 獲得EXP +${expGained}`,
        result.isPlayerWin ? 'success' : 'info'
    );

    const matchResult = {
        playerStyle: styles[player.style].name,
        enemyName: result.cpu.name,
        enemyStyle: styles[result.cpu.style].name,
        mode: result.mode,
        tacticId: result.tacticId,
        tacticName,
        rivalId: result.rivalId || null,
        result: result.result,
        winRate: Number(result.finalWinRate.toFixed(4)),
        expGained,
        log: result.battleLines
    };

    saveMatchResult(matchResult).then(saved => {
        if (!saved) {
            addLog('試合履歴の保存に失敗しました（ゲームは継続できます）。', 'warning');
        }
    });

    renderAll();
    autoSavePlayer('match_finished');

    lastBattleResult = {
        isTournament: false,
        isPlayerWin: result.isPlayerWin,
        playerName: player.name,
        playerStyle: player.style !== null ? styles[player.style].name : '未選択',
        cpuName: result.cpu.name,
        cpuStyle: styles[result.cpu.style].name,
        playerPower: result.playerPower,
        cpuPower: result.cpuPower,
        expGained,
        battleLines: result.battleLines,
        playerLevel: player.level,
        playerExp: player.exp,
        playerWins: player.wins,
        playerLosses: player.losses
    };
    changeScreen('battleResult');
}

function startPracticeMatch() {
    if (player.style === null) {
        addLog('試合前に戦型を選択してください！', 'warning');
        return;
    }

    updateCurrentModeLabel('practice');
    const result = simulateBattleWithOptions({
        mode: 'practice',
        tacticId: selectedTacticId
    });
    applyMatchResult(result);
}

function startRivalMatch(rivalId) {
    if (player.style === null) {
        addLog('試合前に戦型を選択してください！', 'warning');
        return;
    }

    updateCurrentModeLabel('rival');
    const result = simulateBattleWithOptions({
        mode: 'rival',
        rivalId,
        tacticId: selectedTacticId
    });
    applyMatchResult(result);
}

function startTournament() {
    if (player.style === null) {
        addLog('大会参加前に戦型を選択してください！', 'warning');
        return;
    }

    updateCurrentModeLabel('tournament');

    const tournamentLogs = ['大会モードを開始した。'];
    let totalExp = 0;
    let wins = 0;
    let lastResult = null;

    for (let round = 1; round <= 3; round += 1) {
        const roundResult = simulateBattleWithOptions({
            mode: 'tournament',
            tacticId: selectedTacticId,
            roundIndex: round - 1
        });

        lastResult = roundResult;
        tournamentLogs.push(...roundResult.battleLines);

        if (roundResult.result === 'win') {
            wins += 1;
            player.wins += 1;
            totalExp += calculateExpReward('tournament', 'win', { roundIndex: round - 1 });
        } else {
            player.losses += 1;
            totalExp += calculateExpReward('tournament', 'lose', { roundIndex: round - 1 });
            tournamentLogs.push('敗北したため、大会はここで終了です。');
            break;
        }
    }

    if (!lastResult) {
        return;
    }

    if (wins === 3) {
        totalExp += calculateExpReward('tournament', 'win', { isChampion: true }) - calculateExpReward('tournament', 'win');
        tournamentLogs.push('大会優勝！優勝ボーナスを獲得しました。');
    }

    awardExp(totalExp);
    renderBattleLog(tournamentLogs);
    updateBattleResultView(lastResult.cpu, lastResult.playerPower, lastResult.cpuPower, lastResult.finalWinRate, lastResult.isPlayerWin);
    const tournamentResult = wins === 3 ? 'win' : 'lose';
    renderCharacters(lastResult.cpu);
    playBattleLogAnimation(tournamentLogs, tournamentResult);
    addLog(`大会終了: ${wins}勝 | 獲得EXP +${totalExp}`, wins === 3 ? 'success' : 'info');

    saveMatchResult({
        playerStyle: styles[player.style].name,
        enemyName: lastResult ? lastResult.cpu.name : null,
        enemyStyle: lastResult ? styles[lastResult.cpu.style].name : '-',
        mode: 'tournament',
        tacticId: selectedTacticId,
        tacticName: getTacticById(selectedTacticId)?.name || '未設定',
        result: tournamentResult,
        winRate: lastResult ? Number(lastResult.finalWinRate.toFixed(4)) : 0,
        expGained: totalExp,
        roundsWon: wins,
        isChampion: wins === 3,
        log: tournamentLogs
    }).then(saved => {
        if (!saved) {
            addLog('大会履歴の保存に失敗しました（ゲームは継続できます）。', 'warning');
        }
    });

    renderAll();
    autoSavePlayer('tournament_finished');

    lastBattleResult = {
        isTournament: true,
        isPlayerWin: wins === 3,
        wins,
        playerName: player.name,
        playerStyle: player.style !== null ? styles[player.style].name : '未選択',
        cpuName: lastResult.cpu.name,
        cpuStyle: styles[lastResult.cpu.style].name,
        playerPower: lastResult.playerPower,
        cpuPower: lastResult.cpuPower,
        expGained: totalExp,
        battleLines: tournamentLogs,
        playerLevel: player.level,
        playerExp: player.exp,
        playerWins: player.wins,
        playerLosses: player.losses
    };
    changeScreen('battleResult');
}

// ============================================================
// ゲームイベントハンドラ
// ============================================================

function setupStyleButtons() {
    const styleButtons = document.querySelectorAll('.style-btn');
    styleButtons.forEach(button => {
        button.addEventListener('click', function() {
            if (isSetupComplete()) {
                addLog('戦型は初期設定後に変更できません。', 'warning');
                return;
            }
            const styleIndex = parseInt(this.getAttribute('data-style'), 10);
            styleButtons.forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');

            player.style = styleIndex;
            updateStyleInfo();
            addLog(`「${styles[styleIndex].name}」を選択しました！`, 'success');
            triggerAutoSave();
        });
    });
}

function setupTrainingButtons() {
    const trainingButtons = document.querySelectorAll('.training-btn');
    const expCost = BALANCE_CONFIG.exp.base;

    trainingButtons.forEach(button => {
        button.addEventListener('click', function() {
            const stat = this.getAttribute('data-stat');

            if (player.style === null) {
                addLog('戦型を先に選択してください！', 'warning');
                return;
            }

            if (player.usableExp < expCost) {
                addLog(`${stat.toUpperCase()}の強化には${expCost}EXPが必要です。現在: ${player.usableExp}EXP`, 'warning');
                return;
            }

            player.usableExp -= expCost;
            player[stat] += 1;
            autoSavePlayer('training_upgraded');

            const oldLevel = player.level;
            player.level += 1;
            const levelDiff = player.level - oldLevel;
            if (levelDiff > 0) {
                autoSavePlayer('level_up');
            }

            for (let i = 0; i < levelDiff; i += 1) {
                if (getUnownedSkills(player).length === 0) {
                    break;
                }
                gainRandomSkill(player);
            }

            updateStats();
            updatePlayerInfo();
            renderTrainingScreen();
            updateSkillUI();

            addLog(`${styles[player.style].name}で${getStatName(stat)}強化を実施！ ${stat.toUpperCase()}が+1になりました（${expCost}EXP消費）`, 'success');
        });
    });
}

function setupDebugSkillButton() {
    const debugButton = document.getElementById('debugGainSkillButton');
    if (!debugButton) {
        return;
    }

    debugButton.addEventListener('click', function() {
        gainRandomSkill(player);
        updateSkillUI();
    });
}

function setupSkillButtons() {
    const ownedListElement = document.getElementById('ownedSkillList');
    const equippedListElement = document.getElementById('equippedSkillList');

    if (ownedListElement) {
        ownedListElement.addEventListener('click', function(event) {
            const target = event.target;
            if (!target.classList.contains('equip-skill-btn')) {
                return;
            }

            const skillId = target.getAttribute('data-skill-id');
            equipSkill(player, skillId);
        });
    }

    if (equippedListElement) {
        equippedListElement.addEventListener('click', function(event) {
            const target = event.target;
            if (!target.classList.contains('unequip-skill-btn')) {
                return;
            }

            const skillId = target.getAttribute('data-skill-id');
            unequipSkill(player, skillId);
        });
    }
}

function setupBattleButton() {
    const battleButton = document.getElementById('startBattleBtn');
    battleButton.addEventListener('click', function() {
        startPracticeMatch();
    });
}

function setupConfirmStartBattleButton() {
    const btn = document.getElementById('confirmStartBattleBtn');
    if (!btn) {
        return;
    }

    btn.addEventListener('click', function() {
        if (player.style === null) {
            addLog('試合前に戦型を選択してください！', 'warning');
            changeScreen('home');
            return;
        }

        updateCurrentModeLabel('practice');
        const result = simulateBattleWithOptions({
            mode: 'practice',
            tacticId: selectedTacticId,
            enemy: battleStartCpu || undefined
        });
        applyMatchResult(result);
    });
}

function setupTournamentButton() {
    const tournamentButton = document.getElementById('startTournamentBtn');
    if (!tournamentButton) {
        return;
    }

    tournamentButton.addEventListener('click', function() {
        startTournament();
    });
}

function setupBattleResultButtons() {
    const playAgainBtn = document.getElementById('brPlayAgainBtn');
    if (playAgainBtn) {
        playAgainBtn.addEventListener('click', function() {
            changeScreen('battleStart');
        });
    }
}

function setupTacticSelect() {
    const tacticSelect = document.getElementById('tacticSelect');
    if (!tacticSelect) {
        return;
    }

    tacticSelect.addEventListener('change', function(event) {
        selectedTacticId = event.target.value;
        renderTactics();
        const selected = getTacticById(selectedTacticId);
        if (selected) {
            addLog(`作戦を「${selected.name}」に変更しました。`, 'info');
        }
    });
}

function setupRivalButtons() {
    const rivalList = document.getElementById('rivalList');
    if (!rivalList) {
        return;
    }

    rivalList.addEventListener('click', function(event) {
        const target = event.target;
        if (!target.classList.contains('rival-battle-btn')) {
            return;
        }

        const rivalId = target.getAttribute('data-rival-id');
        if (!rivalId) {
            return;
        }

        startRivalMatch(rivalId);
    });
}

function setupManualSaveButton() {
    const saveButton = document.getElementById('manualSaveBtn');
    if (!saveButton) {
        return;
    }

    saveButton.addEventListener('click', async function() {
        if (!isFirebaseReady) {
            updateSaveStatus('手動保存不可: Firebase未接続');
            addLog('Firebase未接続のため手動保存できません。', 'warning');
            return;
        }

        const ok = await savePlayerData('手動保存中...');
        addLog(ok ? '手動保存が完了しました。' : '手動保存に失敗しました。', ok ? 'success' : 'warning');
    });
}

function getStatName(stat) {
    const statNames = {
        atk: '攻撃力（ATK）',
        def: '守備力（DEF）',
        spd: 'スピード（SPD）',
        tec: '技術（TEC）',
        sta: 'スタミナ（STA）'
    };
    return statNames[stat] || stat;
}

// ============================================================
// 初回セットアップ
// ============================================================

let setupSelectedStyleIndex = null;
let setupPlayerName = '';

function isSetupComplete() {
    // player.style !== null handles backwards compatibility for existing players
    // who had a style set before the initialSetupCompleted flag was introduced
    return player.initialSetupCompleted ||
           localStorage.getItem(LOCAL_SETUP_COMPLETE_KEY) === '1' ||
           player.style !== null;
}

function showSetupOverlay() {
    const overlay = document.getElementById('setupOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
    updateSetupLabels();
}

function updateSetupLabels() {
    const totalSteps = (isNewPlayerSetup && isFirebaseReady) ? 3 : 2;
    const step1Label = document.getElementById('setupStep1Label');
    const step2Label = document.getElementById('setupStep2Label');
    const confirmBtn = document.getElementById('setupConfirmBtn');

    if (step1Label) {
        step1Label.textContent = `STEP 1 / ${totalSteps} \u2014 選手名入力`;
    }
    if (step2Label) {
        step2Label.textContent = `STEP 2 / ${totalSteps} \u2014 戦型選択`;
    }
    if (confirmBtn) {
        confirmBtn.textContent = (isNewPlayerSetup && isFirebaseReady) ? '次へ →' : 'この設定で始める ✓';
    }
}

function hideSetupOverlay() {
    const overlay = document.getElementById('setupOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function renderSetupStyleList() {
    const container = document.getElementById('setupStyleList');
    if (!container) {
        return;
    }

    const categories = ['攻撃系', 'カウンター系', '守備系'];
    container.innerHTML = categories.map(cat => {
        const catStyles = styles.filter(s => s.category === cat);
        return `
            <div class="setup-style-category">
                <h4 class="setup-style-cat-label">${cat}</h4>
                <div class="setup-style-buttons">
                    ${catStyles.map(style => `
                        <button class="setup-style-btn" data-style="${style.id}">${style.name}</button>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function completeInitialSetup(name, styleIndex) {
    player.name = name;
    player.style = styleIndex;
    player.initialSetupCompleted = true;

    localStorage.setItem(LOCAL_SETUP_COMPLETE_KEY, '1');

    hideSetupOverlay();
    renderAll();

    addLog(`選手名「${name}」、戦型「${styles[styleIndex].name}」で初期設定完了！`, 'success');
    autoSavePlayer('initial_setup');
}

function setupInitialSetupOverlay() {
    renderSetupStyleList();

    const step1 = document.getElementById('setupStep1');
    const step2 = document.getElementById('setupStep2');
    const nameInput = document.getElementById('setupNameInput');
    const step1NextBtn = document.getElementById('setupStep1NextBtn');
    const confirmBtn = document.getElementById('setupConfirmBtn');

    if (!step1 || !step2 || !nameInput || !step1NextBtn || !confirmBtn) {
        return;
    }

    step1NextBtn.addEventListener('click', function() {
        const name = nameInput.value.trim();
        const nameError = document.getElementById('setupNameError');
        if (!name) {
            nameInput.focus();
            nameInput.classList.add('setup-input-error');
            if (nameError) {
                nameError.style.display = 'block';
            }
            return;
        }
        nameInput.classList.remove('setup-input-error');
        if (nameError) {
            nameError.style.display = 'none';
        }
        setupPlayerName = name;
        step1.style.display = 'none';
        step2.style.display = 'block';
        setupSelectedStyleIndex = null;
        confirmBtn.disabled = true;
    });

    nameInput.addEventListener('input', function() {
        nameInput.classList.remove('setup-input-error');
        const nameError = document.getElementById('setupNameError');
        if (nameError) {
            nameError.style.display = 'none';
        }
    });

    const setupStyleList = document.getElementById('setupStyleList');
    if (setupStyleList) {
        setupStyleList.addEventListener('click', function(event) {
            const btn = event.target.closest('.setup-style-btn');
            if (!btn) {
                return;
            }

            const styleIndex = parseInt(btn.getAttribute('data-style'), 10);
            setupSelectedStyleIndex = styleIndex;

            document.querySelectorAll('.setup-style-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const selectedStyleInfo = document.getElementById('setupSelectedStyleInfo');
            if (selectedStyleInfo) {
                const style = styles[styleIndex];
                selectedStyleInfo.innerHTML = `
                    <strong>${style.name}</strong>
                    <p>${style.description}</p>
                `;
            }

            confirmBtn.disabled = false;
        });
    }

    confirmBtn.addEventListener('click', function() {
        if (!setupPlayerName || setupSelectedStyleIndex === null) {
            return;
        }
        if (isNewPlayerSetup && isFirebaseReady) {
            step2.style.display = 'none';
            const step3 = document.getElementById('setupStep3');
            if (step3) {
                step3.style.display = 'block';
            }
        } else {
            completeInitialSetup(setupPlayerName, setupSelectedStyleIndex);
        }
    });

    const step3ConfirmBtn = document.getElementById('setupStep3ConfirmBtn');
    if (step3ConfirmBtn) {
        step3ConfirmBtn.addEventListener('click', async function() {
            const pwInput = document.getElementById('setupPasswordInput');
            const pwConfirmInput = document.getElementById('setupPasswordConfirmInput');
            const pwError = document.getElementById('setupPasswordError');
            const pwConfirmError = document.getElementById('setupPasswordConfirmError');

            const pw = pwInput ? pwInput.value.trim() : '';
            const pwConfirm = pwConfirmInput ? pwConfirmInput.value.trim() : '';

            let valid = true;
            if (!/^\d{4}$/.test(pw)) {
                if (pwError) {
                    pwError.textContent = 'パスワードは4桁の数字で入力してください';
                    pwError.style.display = 'block';
                }
                valid = false;
            } else {
                if (pwError) {
                    pwError.style.display = 'none';
                }
            }

            if (pw !== pwConfirm) {
                if (pwConfirmError) {
                    pwConfirmError.style.display = 'block';
                }
                valid = false;
            } else {
                if (pwConfirmError) {
                    pwConfirmError.style.display = 'none';
                }
            }

            if (!valid) {
                return;
            }

            step3ConfirmBtn.disabled = true;
            step3ConfirmBtn.textContent = '登録中...';
            await completeInitialSetupWithPassword(setupPlayerName, setupSelectedStyleIndex, pw);
            step3ConfirmBtn.disabled = false;
            step3ConfirmBtn.textContent = '登録して始める ✓';
        });

        const pwInput = document.getElementById('setupPasswordInput');
        const pwConfirmInput = document.getElementById('setupPasswordConfirmInput');
        if (pwInput) {
            pwInput.addEventListener('input', function() {
                const pwError = document.getElementById('setupPasswordError');
                if (pwError) {
                    pwError.style.display = 'none';
                }
            });
        }
        if (pwConfirmInput) {
            pwConfirmInput.addEventListener('input', function() {
                const pwConfirmError = document.getElementById('setupPasswordConfirmError');
                if (pwConfirmError) {
                    pwConfirmError.style.display = 'none';
                }
            });
        }
    }
}

// ============================================================
// v0.12 ログイン・パスワード機能
// ============================================================

async function completeInitialSetupWithPassword(name, styleIndex, password) {
    player.name = name;
    player.style = styleIndex;
    player.initialSetupCompleted = true;

    localStorage.setItem(LOCAL_SETUP_COMPLETE_KEY, '1');

    hideSetupOverlay();
    renderAll();

    addLog(`選手名「${name}」、戦型「${styles[styleIndex].name}」で初期設定完了！`, 'success');
    autoSavePlayer('initial_setup');

    if (password && isFirebaseReady && db && currentPlayerId) {
        try {
            const hash = await hashPassword(password);
            await db.collection('players').doc(currentPlayerId).set({ passwordHash: hash }, { merge: true });
            addLog('パスワードを設定しました。次回は「前に作った選手の続き」でログインできます。', 'success');
        } catch (error) {
            console.error('Failed to save password', error);
            addLog('パスワードの保存に失敗しました。後でパスワード変更から再設定してください。', 'warning');
        }
    }
}

async function findPlayerByName(name) {
    if (!isFirebaseReady || !db) {
        return null;
    }
    try {
        const snapshot = await db.collection('players').where('name', '==', name).get();
        if (snapshot.empty) {
            return null;
        }
        return snapshot.docs[0];
    } catch (error) {
        console.error('Failed to find player by name', error);
        return null;
    }
}

async function loginWithNameAndPassword(name, password) {
    if (!isFirebaseReady || !db) {
        return { success: false, error: 'Firebase未接続です。オンライン環境が必要です。' };
    }
    try {
        const doc = await findPlayerByName(name);
        if (!doc) {
            return { success: false, error: '選手が見つかりません。選手名を確認してください。' };
        }

        const data = doc.data();
        const hasPassword = !!data.passwordHash;

        if (hasPassword) {
            const inputHash = await hashPassword(password);
            if (inputHash !== data.passwordHash) {
                return { success: false, error: 'パスワードが間違っています。' };
            }
        }

        currentPlayerId = doc.id;
        localStorage.setItem(LOCAL_PLAYER_ID_KEY, currentPlayerId);
        const loaded = normalizePlayerData(data, currentPlayerId);
        applyPlayerDataToRuntime(loaded);
        updateSaveStatus('データ読込完了');
        return { success: true, hasPassword };
    } catch (error) {
        console.error('Login failed', error);
        return { success: false, error: 'ログインに失敗しました。しばらく待ってから再試行してください。' };
    }
}

function showLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
    }
}

function hideLoginOverlay() {
    const overlay = document.getElementById('loginOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function setupLoginOverlay() {
    const btnNewPlayer = document.getElementById('loginNewPlayerBtn');
    const btnContinue = document.getElementById('loginContinueBtn');
    const loginBackBtn = document.getElementById('loginBackBtn');
    const loginSubmitBtn = document.getElementById('loginSubmitBtn');
    const loginFormScreen = document.getElementById('loginFormScreen');
    const loginChoiceScreen = document.getElementById('loginChoiceScreen');

    if (!btnNewPlayer || !btnContinue) {
        return;
    }

    btnNewPlayer.addEventListener('click', async function() {
        isNewPlayerSetup = true;
        hideLoginOverlay();
        await loadOrCreatePlayerData();
        renderAll();
        showSetupOverlay();
        addLog('新しい選手を作成します。選手名と戦型を設定してください。', 'info');
    });

    btnContinue.addEventListener('click', function() {
        const choiceErrorEl = document.getElementById('loginChoiceError');
        if (!isFirebaseReady || !db) {
            if (choiceErrorEl) {
                choiceErrorEl.textContent = 'Firebase未接続です。オンライン環境でのみ利用できます。';
                choiceErrorEl.style.display = 'block';
            }
            return;
        }
        if (choiceErrorEl) {
            choiceErrorEl.style.display = 'none';
        }
        if (loginChoiceScreen) {
            loginChoiceScreen.style.display = 'none';
        }
        if (loginFormScreen) {
            loginFormScreen.style.display = 'block';
        }
    });

    if (loginBackBtn) {
        loginBackBtn.addEventListener('click', function() {
            if (loginFormScreen) {
                loginFormScreen.style.display = 'none';
            }
            if (loginChoiceScreen) {
                loginChoiceScreen.style.display = 'block';
            }
            const errorEl = document.getElementById('loginError');
            if (errorEl) {
                errorEl.style.display = 'none';
            }
            const nameInput = document.getElementById('loginNameInput');
            const passInput = document.getElementById('loginPasswordInput');
            if (nameInput) {
                nameInput.value = '';
            }
            if (passInput) {
                passInput.value = '';
            }
        });
    }

    if (loginSubmitBtn) {
        loginSubmitBtn.addEventListener('click', handleLoginSubmit);
    }

    const loginPasswordInput = document.getElementById('loginPasswordInput');
    if (loginPasswordInput) {
        loginPasswordInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                handleLoginSubmit();
            }
        });
    }

    const loginNameInput = document.getElementById('loginNameInput');
    if (loginNameInput) {
        loginNameInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                const passInput = document.getElementById('loginPasswordInput');
                if (passInput) {
                    passInput.focus();
                }
            }
        });
    }
}

async function handleLoginSubmit() {
    const nameInput = document.getElementById('loginNameInput');
    const passInput = document.getElementById('loginPasswordInput');
    const errorEl = document.getElementById('loginError');
    const submitBtn = document.getElementById('loginSubmitBtn');

    const name = nameInput ? nameInput.value.trim() : '';
    const password = passInput ? passInput.value.trim() : '';

    if (!name) {
        if (errorEl) {
            errorEl.textContent = '選手名を入力してください。';
            errorEl.style.display = 'block';
        }
        return;
    }

    if (!/^\d{4}$/.test(password)) {
        if (errorEl) {
            errorEl.textContent = 'パスワードは4桁の数字で入力してください。';
            errorEl.style.display = 'block';
        }
        return;
    }

    if (errorEl) {
        errorEl.style.display = 'none';
    }
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'ログイン中...';
    }

    const result = await loginWithNameAndPassword(name, password);

    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'ログイン';
    }

    if (result.success) {
        hideLoginOverlay();
        renderAll();
        if (isFirebaseReady) {
            updateSaveStatus('待機中');
        }
        if (!result.hasPassword) {
            addLog(`「${name}」でログインしました。パスワードが未設定です。パスワード変更から設定してください。`, 'warning');
        } else {
            addLog(`「${name}」でログインしました！`, 'success');
        }
    } else {
        if (errorEl) {
            errorEl.textContent = result.error;
            errorEl.style.display = 'block';
        }
    }
}

async function changePassword(currentPassword, newPassword) {
    if (!isFirebaseReady || !db || !currentPlayerId) {
        return { success: false, error: 'Firebase未接続です。' };
    }
    try {
        const docRef = db.collection('players').doc(currentPlayerId);
        const snapshot = await docRef.get();
        if (!snapshot.exists) {
            return { success: false, error: 'プレイヤーデータが見つかりません。' };
        }
        const data = snapshot.data();
        if (data.passwordHash) {
            const currentHash = await hashPassword(currentPassword);
            if (currentHash !== data.passwordHash) {
                return { success: false, error: '現在のパスワードが間違っています。' };
            }
        }
        const newHash = await hashPassword(newPassword);
        await docRef.set({ passwordHash: newHash }, { merge: true });
        return { success: true };
    } catch (error) {
        console.error('Failed to change password', error);
        return { success: false, error: 'パスワードの変更に失敗しました。' };
    }
}

function clearChangePasswordForm() {
    ['currentPasswordInput', 'newPasswordInput', 'newPasswordConfirmInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.value = '';
        }
    });
    const errEl = document.getElementById('changePasswordError');
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }
    const successEl = document.getElementById('changePasswordSuccess');
    if (successEl) {
        successEl.textContent = '';
        successEl.style.display = 'none';
    }
}

async function handleChangePassword() {
    const currentPw = (document.getElementById('currentPasswordInput') || {}).value || '';
    const newPw = (document.getElementById('newPasswordInput') || {}).value || '';
    const newPwConfirm = (document.getElementById('newPasswordConfirmInput') || {}).value || '';
    const errEl = document.getElementById('changePasswordError');
    const successEl = document.getElementById('changePasswordSuccess');
    const changeBtn = document.getElementById('changePasswordSubmitBtn');

    const showError = (msg) => {
        if (errEl) {
            errEl.textContent = msg;
            errEl.style.display = 'block';
        }
        if (successEl) {
            successEl.style.display = 'none';
        }
    };

    if (!/^\d{4}$/.test(newPw)) {
        showError('新しいパスワードは4桁の数字で入力してください。');
        return;
    }

    if (newPw !== newPwConfirm) {
        showError('パスワードが一致しません。');
        return;
    }

    if (changeBtn) {
        changeBtn.disabled = true;
        changeBtn.textContent = '変更中...';
    }

    const result = await changePassword(currentPw.trim(), newPw.trim());

    if (changeBtn) {
        changeBtn.disabled = false;
        changeBtn.textContent = '変更する';
    }

    if (result.success) {
        if (errEl) {
            errEl.style.display = 'none';
        }
        if (successEl) {
            successEl.textContent = 'パスワードを変更しました。';
            successEl.style.display = 'block';
        }
        addLog('パスワードを変更しました。', 'success');
        setTimeout(() => {
            const modal = document.getElementById('changePasswordModal');
            if (modal) {
                modal.style.display = 'none';
            }
            clearChangePasswordForm();
        }, 2000);
    } else {
        showError(result.error);
    }
}

function setupChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    const openBtn = document.getElementById('openChangePasswordBtn');
    const closeBtn = document.getElementById('closeChangePasswordBtn');
    const changeBtn = document.getElementById('changePasswordSubmitBtn');

    if (openBtn) {
        openBtn.addEventListener('click', function() {
            if (!isFirebaseReady || !db) {
                addLog('Firebase未接続のためパスワード変更はできません。', 'warning');
                return;
            }
            if (!currentPlayerId) {
                addLog('プレイヤーデータが読み込まれていません。', 'warning');
                return;
            }
            clearChangePasswordForm();
            if (modal) {
                modal.style.display = 'flex';
            }
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            if (modal) {
                modal.style.display = 'none';
            }
            clearChangePasswordForm();
        });
    }

    if (changeBtn) {
        changeBtn.addEventListener('click', handleChangePassword);
    }
}

function setupLogoutButton() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (!logoutBtn) {
        return;
    }
    logoutBtn.addEventListener('click', function() {
        if (!confirm('ログアウトしますか？\nログアウトするとログイン画面に戻ります。')) {
            return;
        }
        localStorage.removeItem(LOCAL_PLAYER_ID_KEY);
        localStorage.removeItem(LOCAL_SETUP_COMPLETE_KEY);
        location.reload();
    });
}

// ============================================================
// ゲーム初期化
// ============================================================

async function initGame() {
    updateSaveStatus('初期化中...');
    initFirebase();

    ensurePlayerSkills(player);
    ensurePlayerEquippedSkills(player);
    cleanupEquippedSkills(player);

    renderAll();

    setupStyleButtons();
    setupTrainingButtons();
    setupSkillButtons();
    setupBattleButton();
    setupConfirmStartBattleButton();
    setupTournamentButton();
    setupBattleModeSelectButtons();
    setupTacticSelect();
    setupRivalButtons();
    setupDebugSkillButton();
    setupManualSaveButton();
    setupBattleResultButtons();
    setupInitialSetupOverlay();
    setupLoginOverlay();
    setupChangePasswordModal();
    setupLogoutButton();
    setupNavButtons();
    changeScreen('home');

    const existingPlayerId = localStorage.getItem(LOCAL_PLAYER_ID_KEY);
    if (existingPlayerId) {
        await loadOrCreatePlayerData();
        renderAll();

        if (!isSetupComplete()) {
            showSetupOverlay();
        }

        if (isFirebaseReady) {
            updateSaveStatus('待機中');
        }

        addLog('ゲーム開始！戦型を選択して育成を開始してください。', 'info');
    } else {
        showLoginOverlay();
    }
}

window.addEventListener('DOMContentLoaded', initGame);
