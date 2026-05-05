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

// ============================================================
// 戦型別ステータス上限
// ============================================================

const STYLE_STAT_CAPS = {
    0: { atk: 120, def: 80,  spd: 130, tec: 100, sta: 90  }, // 前陣速攻型
    1: { atk: 125, def: 85,  spd: 100, tec: 120, sta: 90  }, // オールフォア型
    2: { atk: 135, def: 85,  spd: 90,  tec: 100, sta: 120 }, // パワー両ハンド型
    3: { atk: 90,  def: 125, spd: 95,  tec: 125, sta: 100 }, // ブロック＆カウンター型
    4: { atk: 125, def: 95,  spd: 100, tec: 125, sta: 85  }, // 一撃カウンター型
    5: { atk: 110, def: 110, spd: 110, tec: 110, sta: 110 }, // オールラウンド型
    6: { atk: 80,  def: 120, spd: 95,  tec: 130, sta: 105 }, // ペン粒型
    7: { atk: 85,  def: 135, spd: 80,  tec: 110, sta: 130 }, // カットマン型
    8: { atk: 105, def: 115, spd: 105, tec: 125, sta: 95  }  // 異質攻守型
};

let db = null;
let isFirebaseReady = false;
let currentPlayerId = null;
let autoSaveTimerId = null;
const pendingAutoSaveReasons = new Set();
let isNewPlayerSetup = false;

// ============================================================
// Firestore書き込み管理
// ============================================================

// デバッグ用: 1セッション中のFirestore書き込み回数を追跡する
let debugFirestoreWriteCount = 0;

// 前回保存済みのプレイヤーデータのスナップショット（差分チェック用）
let lastSavedPlayerData = null;

// ============================================================
// プレイヤー名バリデーション
// ============================================================

const BLOCKED_NAME_WORDS = [
    'admin', 'administrator', 'official', 'system', 'guest',
    'moderator', 'mod', 'null', 'undefined',
    '公式', '運営', '管理者', '開発者', '管理人', 'サポート', 'スタッフ'
];

/**
 * プレイヤー名を正規化する（前後の空白削除・全角英数字を半角に変換）
 * @param {string} name
 * @returns {string}
 */
function normalizePlayerName(name) {
    if (typeof name !== 'string') return '';
    let normalized = name.trim();
    // 全角英数字を半角に変換 (全角と半角のUnicodeオフセット差: U+FF00 - U+0020 = 0xFEE0)
    normalized = normalized.replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch =>
        String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    );
    return normalized;
}

/**
 * 禁止ワードを含むか確認する
 * @param {string} name 正規化済みの名前
 * @returns {boolean}
 */
function containsBlockedWord(name) {
    const lower = name.toLowerCase();
    return BLOCKED_NAME_WORDS.some(word => lower.includes(word.toLowerCase()));
}

// ひらがな・カタカナ・漢字・ASCII英数字・全角英数字のいずれかを含むか確認する正規表現
// \u3040-\u309F: ひらがな, \u30A0-\u30FF: カタカナ, \u4E00-\u9FFF: CJK統合漢字
// \u3400-\u4DBF: CJK統合漢字拡張A, \uFF10-\uFF19: 全角数字, \uFF21-\uFF3A: 全角大文字, \uFF41-\uFF5A: 全角小文字
const VALID_NAME_CHARACTERS_REGEX = /[A-Za-z0-9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/;

/**
 * プレイヤー名のバリデーションを行う
 * @param {string} name
 * @returns {{valid: boolean, message?: string, name?: string}}
 */
function validatePlayerName(name) {
    const normalizedName = normalizePlayerName(name);

    if (!normalizedName) {
        return { valid: false, message: '選手名を入力してください' };
    }

    if (normalizedName.length < 2 || normalizedName.length > 12) {
        return { valid: false, message: '選手名は2〜12文字で入力してください' };
    }

    // HTMLタグや危険な文字を含む場合は拒否
    if (/[<>"'&]/.test(normalizedName)) {
        return { valid: false, message: 'この選手名は使用できません' };
    }

    // アルファベット・数字・日本語文字が一切含まれない（記号・絵文字のみ）場合は拒否
    if (!VALID_NAME_CHARACTERS_REGEX.test(normalizedName)) {
        return { valid: false, message: '記号だけの選手名は使用できません' };
    }

    if (containsBlockedWord(normalizedName)) {
        return { valid: false, message: 'この選手名は使用できません' };
    }

    return { valid: true, name: normalizedName };
}

// ============================================================
// 画面状態管理
// ============================================================

const SCREEN_NAMES = ['home', 'training', 'battleModeSelect', 'ratedBattleStart', 'battleStart', 'battle', 'battleResult', 'data', 'settings', 'ratedBattleAnimation'];
let currentScreen = 'home';

let battleStartCpu = null;
let lastBattleResult = null;

function changeScreen(screenName) {
    if (!SCREEN_NAMES.includes(screenName)) {
        console.warn('changeScreen: 不明な画面名:', screenName);
        return;
    }

    // マッチング中に他画面へ遷移しようとした場合は負け扱いにする
    if (currentScreen === 'ratedBattleStart' && selectedRatedOpponent !== null && screenName !== 'ratedBattleStart') {
        if (!confirm('マッチング相手が見つかっています。\n画面を離れると負け扱いになります。よろしいですか？')) {
            return;
        }
        applyRatedBattleForfeit();
    }

    if (currentScreen === 'battleStart' && battleStartCpu !== null && screenName !== 'battleStart') {
        if (!confirm('対戦相手が待機しています。\n画面を離れると負け扱いになります。よろしいですか？')) {
            return;
        }
        applyCpuBattleForfeit();
    }

    // 育成画面から離れる際に変更があればまとめて保存する（逐次保存を防ぐ）
    if (currentScreen === 'training' && screenName !== 'training') {
        savePlayerDataIfChanged('育成結果を保存中...').catch(err => {
            console.error('Training save on navigate failed', err);
        });
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

    if (screenName === 'ratedBattleStart') {
        showRatedBattleStartScreen();
    }

    if (screenName === 'battleResult') {
        renderBattleResultScreen();
    }
}

function applyRatedBattleForfeit() {
    if (!selectedRatedOpponent) {
        return;
    }

    const playerDisplayRate = calculateEffectiveRate(player.rate, player.ratedMatches);
    const opponentDisplayRate = Number.isFinite(selectedRatedOpponent.displayRate)
        ? selectedRatedOpponent.displayRate
        : calculateEffectiveRate(selectedRatedOpponent.rate || 1500, selectedRatedOpponent.ratedMatches || 0);
    const rateChange = calculateRateChange(playerDisplayRate, opponentDisplayRate, false);

    const displayRateBefore = playerDisplayRate;

    player.ratedMatches = (player.ratedMatches || 0) + 1;
    player.ratedLosses = (player.ratedLosses || 0) + 1;
    player.rate = (player.rate || 1500) + rateChange;
    player.lastRatedBattleAt = new Date();

    const displayRateAfter = calculateEffectiveRate(player.rate, player.ratedMatches);
    player.maxRate = Number.isFinite(player.maxRate) ? Math.max(player.maxRate, displayRateAfter) : displayRateAfter;

    const netRateChange = displayRateAfter - displayRateBefore;
    addLog(`対戦をキャンセルしました。負け扱い。Rate変動: ${netRateChange >= 0 ? '+' : ''}${netRateChange}`, 'warning');

    selectedRatedOpponent = null;
    autoSavePlayer('match_finished');
}

function applyCpuBattleForfeit() {
    player.losses = (player.losses || 0) + 1;
    addLog('対戦をキャンセルしました。負け扱いになります。', 'warning');
    battleStartCpu = null;
    autoSavePlayer('match_finished');
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
    changeScreen('ratedBattleStart');
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

// ============================================================
// 全国Rate対戦開始画面
// ============================================================

const RATED_PROVISIONAL_THRESHOLD = 20;
const MAX_PROVISIONAL_PENALTY = 300;
const RATING_K_FACTOR = 32;
const MAX_OPPONENT_POOL_SIZE = 10;
const MAX_OPPONENT_FETCH_SIZE = 50;
let selectedRatedOpponent = null;
let lastRatedOpponentId = null;
let recentRatedWins = 0;
let recentRatedLosses = 0;

function getRatedBattleCatchCopy(context) {
    const { phase, rateDiff, recentWins, recentLosses } = context || {};

    if (phase === 'start') {
        const totalRecent = (recentWins || 0) + (recentLosses || 0);
        if (totalRecent === 0) {
            return '最初の一戦が、君の伝説の始まり。';
        }
        if ((recentWins || 0) >= 3) {
            return 'いい流れです。このまま駆け上がろう。';
        }
        if ((recentLosses || 0) >= 3) {
            return '負けから見える、次の一手。';
        }
        return '今日の道場破り、誰に挑む？';
    }

    if (phase === 'opponentFound') {
        if (rateDiff >= 100) {
            return '強敵こそ、成長のチャンス。';
        }
        if (rateDiff > -100) {
            return '腕試しにはちょうどいい相手です。';
        }
        return '油断は禁物。勝ち切ろう。';
    }

    return '今日の道場破り';
}

function calculateProvisionalPenalty(ratedMatches) {
    const matches = Math.min(ratedMatches, RATED_PROVISIONAL_THRESHOLD);
    const remainingRatio = (RATED_PROVISIONAL_THRESHOLD - matches) / RATED_PROVISIONAL_THRESHOLD;
    return Math.round(MAX_PROVISIONAL_PENALTY * remainingRatio * remainingRatio);
}

function calculateEffectiveRate(rate, ratedMatches) {
    return rate - calculateProvisionalPenalty(ratedMatches);
}

function calculateRateChange(myRate, opponentRate, isWin) {
    const expected = 1 / (1 + Math.pow(10, (opponentRate - myRate) / 400));
    const actual = isWin ? 1 : 0;
    return Math.round(RATING_K_FACTOR * (actual - expected));
}

function showRatedBattleStartScreen() {
    renderRatedBattleSummary(player);
    renderRecentRatedBattleList(currentPlayerId);

    const opponentArea = document.getElementById('ratedOpponentArea');
    if (opponentArea) {
        opponentArea.style.display = 'none';
    }

    const playerSkillArea = document.getElementById('ratedPlayerSkillArea');
    if (playerSkillArea) {
        playerSkillArea.style.display = 'none';
    }

    const findBtn = document.getElementById('findRatedOpponentBtn');
    const startBtn = document.getElementById('startRatedBattleBtn');
    if (findBtn) {
        findBtn.style.display = '';
        findBtn.disabled = false;
    }
    if (startBtn) {
        startBtn.style.display = 'none';
    }

    const statusEl = document.getElementById('ratedSearchStatus');
    if (statusEl) {
        statusEl.textContent = getRatedBattleCatchCopy({
            phase: 'start',
            recentWins: recentRatedWins,
            recentLosses: recentRatedLosses
        });
    }

    selectedRatedOpponent = null;
}

function renderRatedBattleSummary(targetPlayer) {
    const displayRate = calculateEffectiveRate(targetPlayer.rate, targetPlayer.ratedMatches);

    const rateEl = document.getElementById('ratedDisplayRate');
    if (rateEl) {
        rateEl.textContent = displayRate;
    }

    const matches = targetPlayer.ratedMatches || 0;
    const wins = targetPlayer.ratedWins || 0;
    const losses = targetPlayer.ratedLosses || 0;
    const draws = targetPlayer.ratedDraws || 0;

    const recordEl = document.getElementById('ratedRecord');
    if (recordEl) {
        let recordText = `${matches}戦 ${wins}勝${losses}敗`;
        if (draws > 0) {
            recordText += `${draws}分`;
        }
        recordEl.textContent = recordText;
    }

    const winRateEl = document.getElementById('ratedWinRate');
    if (winRateEl) {
        const decidedMatches = wins + losses + draws;
        const winRateText = decidedMatches > 0
            ? `勝率 ${(wins / decidedMatches * 100).toFixed(1)}%`
            : '勝率 -%';
        winRateEl.textContent = winRateText;
    }

    const provisionalEl = document.getElementById('ratedProvisionalArea');
    if (provisionalEl) {
        if (matches < RATED_PROVISIONAL_THRESHOLD) {
            provisionalEl.style.display = '';
            const remainingEl = document.getElementById('ratedProvisionalRemaining');
            if (remainingEl) {
                remainingEl.textContent = `正式Rateまであと${RATED_PROVISIONAL_THRESHOLD - matches}戦`;
            }
        } else {
            provisionalEl.style.display = 'none';
        }
    }

    renderLevelEquipSlotInfo('rated', targetPlayer);
}

async function renderRecentRatedBattleList(playerId) {
    const listEl = document.getElementById('recentRatedBattleList');
    const summaryEl = document.getElementById('recentRatedBattleSummary');
    if (!listEl) {
        return;
    }

    if (!isFirebaseReady || !db || !playerId) {
        recentRatedWins = 0;
        recentRatedLosses = 0;
        listEl.innerHTML = '<p class="rated-no-history">まだRate対戦履歴がありません。<br>最初の道場破りに挑戦しましょう！</p>';
        if (summaryEl) {
            summaryEl.style.display = 'none';
        }
        updateRatedBattleSubtitle();
        return;
    }

    try {
        const snapshot = await db.collection('matches')
            .where('playerId', '==', playerId)
            .where('mode', '==', 'rated')
            .orderBy('createdAt', 'desc')
            .limit(5)
            .get();

        if (snapshot.empty) {
            recentRatedWins = 0;
            recentRatedLosses = 0;
            listEl.innerHTML = '<p class="rated-no-history">まだRate対戦履歴がありません。<br>最初の道場破りに挑戦しましょう！</p>';
            if (summaryEl) {
                summaryEl.style.display = 'none';
            }
            updateRatedBattleSubtitle();
            return;
        }

        let recentWins = 0;
        let recentLosses = 0;
        const items = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            const isWin = d.result === 'win';
            if (isWin) {
                recentWins += 1;
            } else {
                recentLosses += 1;
            }
            const marker = isWin ? '○' : '×';
            const rateChangeVal = d.rateChange;
            const rateChangeText = Number.isFinite(rateChangeVal)
                ? (rateChangeVal >= 0 ? ` +${rateChangeVal}` : ` ${rateChangeVal}`)
                : '';
            const opponentName = d.enemyName || '不明';
            items.push(`<div class="rated-history-item ${isWin ? 'win' : 'lose'}">${marker} vs ${opponentName}${rateChangeText}</div>`);
        });

        recentRatedWins = recentWins;
        recentRatedLosses = recentLosses;
        listEl.innerHTML = items.join('');

        if (summaryEl) {
            summaryEl.textContent = `直近成績: ${recentWins}勝${recentLosses}敗`;
            summaryEl.style.display = '';
        }

        updateRatedBattleSubtitle();
    } catch (error) {
        console.error('Failed to load recent rated battles', error);
        listEl.innerHTML = '<p class="rated-no-history">履歴の読み込みに失敗しました。</p>';
        if (summaryEl) {
            summaryEl.style.display = 'none';
        }
    }
}

function updateRatedBattleSubtitle() {
    const subtitleEl = document.getElementById('ratedBattleSubtitle');
    if (!subtitleEl) {
        return;
    }
    subtitleEl.textContent = getRatedBattleCatchCopy({
        phase: 'start',
        recentWins: recentRatedWins,
        recentLosses: recentRatedLosses
    });
}

async function findRatedOpponent() {
    const playerDisplayRate = calculateEffectiveRate(player.rate, player.ratedMatches);

    if (!isFirebaseReady || !db || !currentPlayerId) {
        return createCpuOpponentForRated(playerDisplayRate);
    }

    try {
        const rateMin = Math.max(100, playerDisplayRate - 300);
        const rateMax = playerDisplayRate + 300 + MAX_PROVISIONAL_PENALTY;
        const snapshot = await db.collection('players')
            .where('rate', '>=', rateMin)
            .where('rate', '<=', rateMax)
            .limit(MAX_OPPONENT_FETCH_SIZE)
            .get();

        const candidates = [];
        snapshot.forEach(doc => {
            if (doc.id === currentPlayerId) {
                return;
            }
            const data = doc.data();
            const oppDisplayRate = calculateEffectiveRate(
                Number.isFinite(data.rate) ? data.rate : 1500,
                Number.isFinite(data.ratedMatches) ? data.ratedMatches : 0
            );
            candidates.push({
                id: doc.id,
                name: data.name || '匿名選手',
                style: Number.isFinite(data.style) ? data.style : 0,
                rate: Number.isFinite(data.rate) ? data.rate : 1500,
                ratedMatches: Number.isFinite(data.ratedMatches) ? data.ratedMatches : 0,
                displayRate: oppDisplayRate,
                atk: Number.isFinite(data.atk) ? data.atk : 10,
                def: Number.isFinite(data.def) ? data.def : 10,
                spd: Number.isFinite(data.spd) ? data.spd : 10,
                tec: Number.isFinite(data.tec) ? data.tec : 10,
                sta: Number.isFinite(data.sta) ? data.sta : 10,
                equippedSkills: Array.isArray(data.equippedSkills) ? data.equippedSkills : []
            });
        });

        if (candidates.length === 0) {
            return createCpuOpponentForRated(playerDisplayRate);
        }

        candidates.sort((a, b) =>
            Math.abs(a.displayRate - playerDisplayRate) - Math.abs(b.displayRate - playerDisplayRate)
        );
        const top10 = candidates.slice(0, MAX_OPPONENT_POOL_SIZE);
        const filtered = top10.filter(c => c.id !== lastRatedOpponentId);
        const pool = filtered.length > 0 ? filtered : top10;
        return pool[Math.floor(Math.random() * pool.length)];
    } catch (error) {
        console.error('Failed to query rated opponents', error);
        return createCpuOpponentForRated(playerDisplayRate);
    }
}

function createCpuOpponentForRated(targetRate) {
    const cpu = createCpuOpponent();
    const offset = Math.round((Math.random() * 60) - 30);
    cpu.rate = targetRate + offset;
    cpu.ratedMatches = 50;
    cpu.displayRate = cpu.rate;
    return cpu;
}

async function handleFindRatedOpponent() {
    const findBtn = document.getElementById('findRatedOpponentBtn');
    const statusEl = document.getElementById('ratedSearchStatus');

    if (findBtn) {
        findBtn.disabled = true;
    }
    if (statusEl) {
        statusEl.textContent = '対戦相手を探しています...';
    }

    try {
        const opponent = await findRatedOpponent();
        if (opponent) {
            selectedRatedOpponent = opponent;
            lastRatedOpponentId = opponent.id || null;
            renderRatedOpponentPreview(opponent);

            const opponentArea = document.getElementById('ratedOpponentArea');
            if (opponentArea) {
                opponentArea.style.display = '';
            }

            if (findBtn) {
                findBtn.style.display = 'none';
            }

            const startBtn = document.getElementById('startRatedBattleBtn');
            if (startBtn) {
                startBtn.style.display = '';
            }

            if (statusEl) {
                statusEl.textContent = '道場の相手が現れた！';
            }
        } else {
            if (statusEl) {
                statusEl.textContent = '対戦相手が見つかりませんでした。';
            }
            if (findBtn) {
                findBtn.disabled = false;
            }
        }
    } catch (error) {
        console.error('Failed to find rated opponent', error);
        if (statusEl) {
            statusEl.textContent = '対戦相手の検索に失敗しました。';
        }
        if (findBtn) {
            findBtn.disabled = false;
        }
    }
}

function renderRatedOpponentPreview(opponent) {
    const nameEl = document.getElementById('ratedOpponentName');
    const rateEl = document.getElementById('ratedOpponentRate');
    const styleEl = document.getElementById('ratedOpponentStyle');
    const diffEl = document.getElementById('ratedRateDiff');
    const commentEl = document.getElementById('ratedOpponentComment');

    const playerDisplayRate = calculateEffectiveRate(player.rate, player.ratedMatches);
    const opponentDisplayRate = Number.isFinite(opponent.displayRate)
        ? opponent.displayRate
        : calculateEffectiveRate(opponent.rate || 1500, opponent.ratedMatches || 0);
    const rateDiff = opponentDisplayRate - playerDisplayRate;

    if (nameEl) {
        nameEl.textContent = opponent.name;
    }
    if (rateEl) {
        rateEl.textContent = `Rate ${opponentDisplayRate}`;
    }

    let styleName = '不明';
    if (styleEl) {
        styleName = Number.isFinite(opponent.style) && styles[opponent.style]
            ? styles[opponent.style].name
            : '不明';
        styleEl.textContent = `戦型: ${styleName}`;
    }

    // 相手戦型ミニ画像
    const opponentCharImgEl = document.getElementById('ratedOpponentCharImg');
    if (opponentCharImgEl) {
        opponentCharImgEl.src = getStyleMiniImageSrc(opponent.style);
        opponentCharImgEl.alt = styleName;
    }

    if (diffEl) {
        const diffText = rateDiff >= 0 ? `Rate差: +${rateDiff}` : `Rate差: ${rateDiff}`;
        let tierText;
        if (rateDiff >= 200) {
            tierText = '強敵です！';
        } else if (rateDiff >= 100) {
            tierText = '格上の相手です';
        } else if (rateDiff > -100) {
            tierText = '同格の相手です';
        } else if (rateDiff > -200) {
            tierText = '格下の相手です';
        } else {
            tierText = '取りこぼし注意！';
        }
        diffEl.innerHTML = `${diffText}<br><span class="rated-tier-label">${tierText}</span>`;
    }

    if (commentEl) {
        commentEl.textContent = getRatedBattleCatchCopy({
            phase: 'opponentFound',
            rateDiff
        });
    }

    // 相手のステータスを表示
    const statsEl = document.getElementById('ratedOpponentStats');
    if (statsEl) {
        statsEl.textContent =
            `ATK: ${opponent.atk}  DEF: ${opponent.def}  SPD: ${opponent.spd}  TEC: ${opponent.tec}  STA: ${opponent.sta}`;
    }

    // 相手の装備スキルを表示
    const skillsEl = document.getElementById('ratedOpponentSkills');
    if (skillsEl) {
        const equippedSkills = (opponent.equippedSkills || [])
            .map(skillId => getSkillById(skillId))
            .filter(Boolean);
        if (equippedSkills.length > 0) {
            skillsEl.innerHTML = equippedSkills
                .map(s => `<span class="skill-badge">${s.name}</span>`)
                .join('');
        } else {
            skillsEl.textContent = 'なし';
        }
    }

    // プレイヤーのスキルカード選択エリアを表示（現在の装備状態を維持）
    const playerSkillArea = document.getElementById('ratedPlayerSkillArea');
    if (playerSkillArea) {
        playerSkillArea.style.display = '';
    }
    cleanupEquippedSkills(player);
    renderPreBattleSkillList('ratedPlayerSkillList', 'ratedEquipSlotsInfo');
}

function handleStartRatedBattle() {
    if (!selectedRatedOpponent) {
        addLog('対戦相手を選んでください。', 'warning');
        return;
    }

    if (player.style === null) {
        addLog('試合前に戦型を選択してください！', 'warning');
        changeScreen('home');
        return;
    }

    updateCurrentModeLabel('rated');

    const result = simulateBattleWithOptions({
        mode: 'rated',
        tacticId: selectedTacticId,
        enemy: selectedRatedOpponent
    });

    const playerDisplayRate = calculateEffectiveRate(player.rate, player.ratedMatches);
    const opponentDisplayRate = Number.isFinite(selectedRatedOpponent.displayRate)
        ? selectedRatedOpponent.displayRate
        : calculateEffectiveRate(selectedRatedOpponent.rate || 1500, selectedRatedOpponent.ratedMatches || 0);
    const rateChange = calculateRateChange(playerDisplayRate, opponentDisplayRate, result.isPlayerWin);

    const displayRateBefore = playerDisplayRate;

    player.ratedMatches = (player.ratedMatches || 0) + 1;
    if (result.isPlayerWin) {
        player.ratedWins = (player.ratedWins || 0) + 1;
    } else {
        player.ratedLosses = (player.ratedLosses || 0) + 1;
    }
    player.rate = (player.rate || 1500) + rateChange;
    player.lastRatedBattleAt = new Date();

    const displayRateAfter = calculateEffectiveRate(player.rate, player.ratedMatches);
    player.maxRate = Number.isFinite(player.maxRate) ? Math.max(player.maxRate, displayRateAfter) : displayRateAfter;

    result.rateChange = displayRateAfter - displayRateBefore;
    result.displayRateBefore = displayRateBefore;
    result.displayRateAfter = displayRateAfter;
    result.ratedMatchesAfter = player.ratedMatches;

    selectedRatedOpponent = null; // 試合開始後はフォーフィット対象外にする
    showRatedBattleAnimation(result);
}

function setupRatedBattleStartButtons() {
    const findBtn = document.getElementById('findRatedOpponentBtn');
    if (findBtn) {
        findBtn.addEventListener('click', handleFindRatedOpponent);
    }

    const startBtn = document.getElementById('startRatedBattleBtn');
    if (startBtn) {
        startBtn.addEventListener('click', handleStartRatedBattle);
    }
}

// ============================================================
// レート戦バトル演出
// ============================================================

let pendingRatedMatchResult = null;
let ratedAnimationAborted = false;
let ratedAnimationResultShown = false;

/**
 * バトルログ行から得点イベントを抽出して構造化データとして返す。
 * 各ログ行の先頭にある [X-Y] 形式のスコアを使って得点者を判定する。
 */
function parseRatedBattleScoringEvents(lines) {
    const scorePattern = /^\[(\d+)-(\d+)\]/;
    const events = [];
    let prevPlayer = 0;
    let prevOpponent = 0;

    for (const line of lines) {
        const match = line.match(scorePattern);
        if (!match) {
            continue;
        }
        const playerScore = parseInt(match[1], 10);
        const opponentScore = parseInt(match[2], 10);

        let pointWinner;
        if (playerScore > prevPlayer) {
            pointWinner = 'player';
        } else if (opponentScore > prevOpponent) {
            pointWinner = 'opponent';
        }

        // スコアが変化していない行はスキップするが、前回スコアは更新する
        prevPlayer = playerScore;
        prevOpponent = opponentScore;

        if (!pointWinner) {
            continue;
        }

        const animationType = inferRatedAnimationType(line);
        events.push({
            text: line.replace(/^\[\d+-\d+\] /, ''),
            pointWinner,
            score: { player: playerScore, opponent: opponentScore },
            animationType
        });
    }

    return events;
}

function inferRatedAnimationType(logText) {
    if (logText.includes('スキル') || logText.includes('発動')) {
        return 'skill';
    }
    if (logText.includes('カウンター') || logText.includes('反撃')) {
        return 'counter';
    }
    if (logText.includes('ブロック') || logText.includes('カット')) {
        return 'defense';
    }
    return 'attack';
}

/**
 * 戦型名から画像フォルダ名を返す。
 */
function getStyleImageFolder(styleName) {
    switch (styleName) {
        case '前陣速攻型':            return '前陣速攻';
        case 'オールフォア型':        return 'オールフォア';
        case 'パワー両ハンド型':      return 'パワー両ハンド';
        case 'ブロック＆カウンター型': return 'ブロックカウンター';
        case '一撃カウンター型':      return '一撃カウンター';
        case 'オールラウンド型':      return 'オールラウンド';
        case 'ペン粒型':              return 'ペン粒';
        case 'カットマン型':          return 'カットマン';
        case '異質攻守型':            return '異質攻守';
        default:                      return 'オールラウンド';
    }
}

/**
 * 戦型名と状態（normal/score/conceded/win/lose）から画像パスを返す。
 */
function getRataCharacterImageSrc(styleName, state) {
    const folder = getStyleImageFolder(styleName);
    return `assets/images/style/${folder}/${state}.webp`;
}

/**
 * 戦型インデックスからノーマル状態の画像パスを返す。
 */
function getStyleMiniImageSrc(styleId) {
    const styleName = (Number.isFinite(styleId) && styles[styleId])
        ? styles[styleId].name
        : 'オールラウンド型';
    return getRataCharacterImageSrc(styleName, 'normal');
 * キャラクター画像の状態を切り替える共通関数。
 * @param {HTMLImageElement} imgEl - 対象の img 要素
 * @param {string} state - 切り替え先の状態（normal/score/conceded/win/lose）
 */
function replaceRataImageState(imgEl, state) {
    if (!imgEl || !imgEl.src) {
        return;
    }

    imgEl.src = imgEl.src.replace(
        /\/(normal|score|conceded|win|lose)\.webp$/,
        `/${state}.webp`
    );
}

/**
 * 画像読み込みエラー時に normal.webp へフォールバックする設定を行う。
 * @param {HTMLImageElement} imgEl - 対象の img 要素
 */
function setupRataImageFallback(imgEl) {
    if (!imgEl) {
        return;
    }

    imgEl.onerror = () => {
        imgEl.onerror = null;
        replaceRataImageState(imgEl, 'normal');
    };
}

function showRatedBattleAnimation(result) {
    pendingRatedMatchResult = result;
    ratedAnimationAborted = false;
    ratedAnimationResultShown = false;

    const playerStyleName = player.style !== null ? styles[player.style].name : 'オールラウンド型';
    const opponentStyleName = styles[result.cpu.style].name;

    const setEl = (id, text) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = text;
        }
    };

    setEl('rataPlayerName', player.name);
    setEl('rataOpponentName', result.cpu.name);
    setEl('rataPlayerScore', '0');
    setEl('rataOpponentScore', '0');

    const playerDisplayRate = Number.isFinite(result.displayRateBefore)
        ? result.displayRateBefore
        : calculateEffectiveRate(player.rate, player.ratedMatches);
    const opponentDisplayRate = Number.isFinite(selectedRatedOpponent?.displayRate)
        ? selectedRatedOpponent.displayRate
        : calculateEffectiveRate(result.cpu.rate || 1500, result.cpu.ratedMatches || 0);

    setEl('rataPlayerRate', `Rate ${playerDisplayRate}`);
    setEl('rataOpponentRate', `Rate ${opponentDisplayRate}`);

    // キャラクター画像を戦型に合わせてセットする
    const playerImgEl = document.getElementById('rata-player-img');
    const opponentImgEl = document.getElementById('rata-opponent-img');
    if (playerImgEl) {
        playerImgEl.src = getRataCharacterImageSrc(playerStyleName, 'normal');
        setupRataImageFallback(playerImgEl);
    }
    if (opponentImgEl) {
        opponentImgEl.src = getRataCharacterImageSrc(opponentStyleName, 'normal');
        setupRataImageFallback(opponentImgEl);
    }

    // アニメーションクラスをリセットする
    const rataPlayerChar = document.getElementById('rata-player-character');
    const rataOpponentChar = document.getElementById('rata-opponent-character');
    const animClasses = ['anim-score', 'anim-skill', 'anim-lose-point', 'anim-win', 'anim-lose'];
    if (rataPlayerChar) {
        rataPlayerChar.classList.remove(...animClasses);
    }
    if (rataOpponentChar) {
        rataOpponentChar.classList.remove(...animClasses);
    }

    const resultArea = document.getElementById('rataResultArea');
    if (resultArea) {
        resultArea.style.display = 'none';
    }

    const logText = document.getElementById('rataLogText');
    if (logText) {
        logText.textContent = '全国Rate対戦 開始！';
    }

    const resultBtn = document.getElementById('rataResultBtn');
    if (resultBtn) {
        resultBtn.style.display = 'none';
    }

    changeScreen('ratedBattleAnimation');

    setTimeout(() => {
        _playRatedBattleAnimationSequence(result);
    }, 800);
}

function _playRatedBattleAnimationSequence(result) {
    const events = parseRatedBattleScoringEvents(result.battleLines);

    if (events.length === 0 || ratedAnimationAborted) {
        _onRatedAnimationAllDone();
        return;
    }

    let index = 0;

    function playNext() {
        if (ratedAnimationAborted) {
            return;
        }

        if (index >= events.length) {
            _showRatedBattleResultSummary(result);
            return;
        }

        const event = events[index];

        const logText = document.getElementById('rataLogText');
        if (logText) {
            logText.textContent = event.text;
        }

        _playRataCharacterAnimation(event.pointWinner, event.animationType);

        const scoreDelay = event.animationType === 'skill' ? 600 : 380;
        setTimeout(() => {
            if (ratedAnimationAborted) {
                return;
            }
            _updateRataScoreboard(event.score.player, event.score.opponent, event.pointWinner);
        }, scoreDelay);

        index++;

        // 最後のイベントは少し長めに表示する
        const isLast = index >= events.length;
        const baseDuration = event.animationType === 'skill' ? 1400 : 1000;
        const duration = isLast ? baseDuration + 500 : baseDuration;
        setTimeout(playNext, duration);
    }

    playNext();
}

function _updateRataScoreboard(playerScore, opponentScore, pointWinner) {
    const playerScoreEl = document.getElementById('rataPlayerScore');
    const opponentScoreEl = document.getElementById('rataOpponentScore');

    if (playerScoreEl) {
        playerScoreEl.textContent = playerScore;
    }
    if (opponentScoreEl) {
        opponentScoreEl.textContent = opponentScore;
    }

    const popEl = pointWinner === 'player' ? playerScoreEl : opponentScoreEl;
    if (popEl) {
        popEl.classList.remove('score-pop');
        // Force reflow to restart animation
        void popEl.offsetWidth;
        popEl.classList.add('score-pop');
        setTimeout(() => popEl.classList.remove('score-pop'), 400);
    }
}

function _playRataCharacterAnimation(pointWinner, animationType) {
    const playerChar = document.getElementById('rata-player-character');
    const opponentChar = document.getElementById('rata-opponent-character');
    const playerImg = document.getElementById('rata-player-img');
    const opponentImg = document.getElementById('rata-opponent-img');

    if (!playerChar || !opponentChar) {
        return;
    }

    const animClasses = ['anim-score', 'anim-skill', 'anim-lose-point', 'anim-win', 'anim-lose'];
    playerChar.classList.remove(...animClasses);
    opponentChar.classList.remove(...animClasses);

    const scorerChar = pointWinner === 'player' ? playerChar : opponentChar;
    const loserChar = pointWinner === 'player' ? opponentChar : playerChar;
    const scorerImg = pointWinner === 'player' ? playerImg : opponentImg;
    const loserImg = pointWinner === 'player' ? opponentImg : playerImg;

    const scoreClass = animationType === 'skill' ? 'anim-skill' : 'anim-score';
    scorerChar.classList.add(scoreClass);
    loserChar.classList.add('anim-lose-point');

    // 得点者は score、失点者は conceded 状態に切り替える
    replaceRataImageState(scorerImg, 'score');
    replaceRataImageState(loserImg, 'conceded');

    setTimeout(() => {
        playerChar.classList.remove(...animClasses);
        opponentChar.classList.remove(...animClasses);
        // 両者の画像を normal 状態に戻す
        replaceRataImageState(playerImg, 'normal');
        replaceRataImageState(opponentImg, 'normal');
    }, 800);
}

function _showRatedBattleResultSummary(result) {
    if (ratedAnimationResultShown) {
        return;
    }
    ratedAnimationResultShown = true;

    // 最終スコアを取得
    const events = parseRatedBattleScoringEvents(result.battleLines);
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;

    if (lastEvent) {
        _updateRataScoreboard(lastEvent.score.player, lastEvent.score.opponent, null);
    }

    const resultArea = document.getElementById('rataResultArea');
    if (resultArea) {
        resultArea.style.display = '';
    }

    const resultText = document.getElementById('rataResultText');
    if (resultText) {
        resultText.textContent = result.isPlayerWin ? '🏆 WIN!' : '😤 LOSE...';
        resultText.className = `rata-result-text ${result.isPlayerWin ? 'rata-result-win' : 'rata-result-lose'}`;
    }

    const finalScoreEl = document.getElementById('rataFinalScore');
    if (finalScoreEl && lastEvent) {
        finalScoreEl.textContent = `最終スコア ${lastEvent.score.player} - ${lastEvent.score.opponent}`;
    }

    if (Number.isFinite(result.rateChange)) {
        const rateChangeEl = document.getElementById('rataRateChange');
        if (rateChangeEl) {
            const sign = result.rateChange >= 0 ? '+' : '';
            rateChangeEl.textContent = `Rate ${sign}${result.rateChange}`;
            rateChangeEl.className = `rata-rate-change ${result.rateChange >= 0 ? 'rata-rate-up' : 'rata-rate-down'}`;
        }
    }

    // 勝敗キャラクターアニメーション・画像切り替え
    const playerChar = document.getElementById('rata-player-character');
    const opponentChar = document.getElementById('rata-opponent-character');
    const playerImg = document.getElementById('rata-player-img');
    const opponentImg = document.getElementById('rata-opponent-img');
    const animClasses = ['anim-score', 'anim-skill', 'anim-lose-point', 'anim-win', 'anim-lose'];
    if (playerChar) {
        playerChar.classList.remove(...animClasses);
        playerChar.classList.add(result.isPlayerWin ? 'anim-win' : 'anim-lose');
    }
    if (opponentChar) {
        opponentChar.classList.remove(...animClasses);
        opponentChar.classList.add(result.isPlayerWin ? 'anim-lose' : 'anim-win');
    }
    // 勝敗画像へ切り替える
    replaceRataImageState(playerImg, result.isPlayerWin ? 'win' : 'lose');
    replaceRataImageState(opponentImg, result.isPlayerWin ? 'lose' : 'win');

    const resultBtn = document.getElementById('rataResultBtn');
    if (resultBtn) {
        resultBtn.style.display = '';
    }
}

function _onRatedAnimationAllDone() {
    if (pendingRatedMatchResult) {
        const r = pendingRatedMatchResult;
        pendingRatedMatchResult = null;
        applyMatchResult(r);
    }
}

function setupRatedBattleAnimationButtons() {
    const resultBtn = document.getElementById('rataResultBtn');
    if (resultBtn) {
        resultBtn.addEventListener('click', () => {
            _onRatedAnimationAllDone();
        });
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

    // プレイヤー戦型ミニ画像
    const playerCharImgEl = document.getElementById('bsPlayerCharImg');
    if (playerCharImgEl) {
        playerCharImgEl.src = getStyleMiniImageSrc(player.style);
        playerCharImgEl.alt = player.style !== null ? styles[player.style].name : '';
    }

    battleStartCpu = createCpuOpponent();
    cpuNameEl.textContent = battleStartCpu.name;
    cpuStyleEl.textContent = styles[battleStartCpu.style].name;
    cpuStatsEl.textContent =
        `ATK: ${battleStartCpu.atk}  DEF: ${battleStartCpu.def}  SPD: ${battleStartCpu.spd}  TEC: ${battleStartCpu.tec}  STA: ${battleStartCpu.sta}`;

    // CPU戦型ミニ画像
    const cpuCharImgEl = document.getElementById('bsCpuCharImg');
    if (cpuCharImgEl) {
        cpuCharImgEl.src = getStyleMiniImageSrc(battleStartCpu.style);
        cpuCharImgEl.alt = (battleStartCpu.style != null && styles[battleStartCpu.style])
            ? styles[battleStartCpu.style].name
            : '';
    }

    // CPUの装備スキルを表示
    const cpuSkillsEl = document.getElementById('bsCpuSkills');
    if (cpuSkillsEl) {
        const cpuEquipped = (battleStartCpu.equippedSkills || [])
            .map(skillId => getSkillById(skillId))
            .filter(Boolean);
        if (cpuEquipped.length > 0) {
            cpuSkillsEl.innerHTML = cpuEquipped
                .map(s => `<span class="skill-badge">${s.name}</span>`)
                .join('');
        } else {
            cpuSkillsEl.textContent = 'なし';
        }
    }

    // プレイヤーのスキルカード選択を表示（現在の装備状態を維持）
    cleanupEquippedSkills(player);
    renderPreBattleSkillList('bsPlayerSkillList', 'bsEquipSlotsInfo');
    renderLevelEquipSlotInfo('bs', player);
}

function formatAdvantageDelta(value) {
    const percent = Math.round(value * 100);
    return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function formatAdvantagePercent(value) {
    return `${Math.round(value * 100)}%`;
}

function renderAdvantageBreakdown(result) {
    const card = document.getElementById('brAdvantageCard');
    const breakdown = result.advantageBreakdown;

    if (!card) {
        return;
    }

    if (!breakdown) {
        card.style.display = 'none';
        return;
    }

    card.style.display = '';

    const setEl = (id, text) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = text;
        }
    };

    setEl('brAdvantageBase', formatAdvantageDelta(breakdown.baseAdvantage || 0));
    setEl('brAdvantageMatchup', formatAdvantageDelta(breakdown.matchupBonus || 0));
    setEl('brAdvantageSkill', formatAdvantageDelta(breakdown.skillBonus || 0));
    setEl('brAdvantageTactic', formatAdvantageDelta(breakdown.tacticBonus || 0));
    setEl('brAdvantagePointRate', formatAdvantagePercent(breakdown.pointWinRate ?? 0.5));
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

    const finalScoreRow = document.getElementById('brFinalScoreRow');
    if (finalScoreRow) {
        if (Number.isFinite(r.playerScore) && Number.isFinite(r.enemyScore)) {
            setEl('brFinalScore', `${r.playerScore} - ${r.enemyScore}`);
            finalScoreRow.style.display = '';
        } else {
            finalScoreRow.style.display = 'none';
        }
    }

    const rateChangeRow = document.getElementById('brRateChangeRow');
    if (rateChangeRow) {
        if (r.mode === 'rated' && r.rateChange !== null) {
            const rateChangeText = r.rateChange >= 0 ? `+${r.rateChange}` : `${r.rateChange}`;
            setEl('brRateChange', rateChangeText);
            setEl('brRateBefore', Number.isFinite(r.displayRateBefore) ? r.displayRateBefore : '-');
            setEl('brRateAfter', Number.isFinite(r.displayRateAfter) ? r.displayRateAfter : '-');
            rateChangeRow.style.display = '';

            const provisionalArea = document.getElementById('brProvisionalArea');
            if (provisionalArea) {
                if (Number.isFinite(r.ratedMatchesAfter) && r.ratedMatchesAfter < RATED_PROVISIONAL_THRESHOLD) {
                    provisionalArea.style.display = '';
                    const remainingEl = document.getElementById('brProvisionalRemaining');
                    if (remainingEl) {
                        remainingEl.textContent = `正式Rateまであと${RATED_PROVISIONAL_THRESHOLD - r.ratedMatchesAfter}戦`;
                    }
                } else {
                    provisionalArea.style.display = 'none';
                }
            }
        } else {
            rateChangeRow.style.display = 'none';
        }
    }

    const logEl = document.getElementById('brBattleLog');
    if (logEl) {
        logEl.innerHTML = r.battleLines
            .map(line => `<div class="battle-log-entry">${line}</div>`)
            .join('');
    }

    const analysisCard = document.getElementById('brAnalysisCard');
    if (analysisCard) {
        if (!r.isTournament) {
            const analysis = r.postMatchAnalysis || {};
            setEl('brResultComment', analysis.resultComment || '試合内容を振り返りましょう。');
            setEl('brKeyPoint', analysis.keyPoint || '育成・スキル・作戦の組み合わせが勝敗に影響します。');
            setEl('brNextAdvice', analysis.nextAdvice || '次の試合では作戦やスキル装備を変えてみましょう。');
            analysisCard.style.display = '';
        } else {
            analysisCard.style.display = 'none';
        }
    }

    renderAdvantageBreakdown(r);
    renderBattleResultLevelUpInfo(r);
}

function renderBattleResultLevelUpInfo(result) {
    const card = document.getElementById('brLevelUpCard');
    const levelText = document.getElementById('brLevelUpText');
    const slotText = document.getElementById('brEquipSlotUpText');

    if (!card || !levelText || !slotText) {
        return;
    }

    const info = result.levelUpInfo;

    if (!info || !info.didLevelUp) {
        card.style.display = 'none';
        return;
    }

    card.style.display = '';
    levelText.textContent = `Lv ${info.levelBefore} → Lv ${info.levelAfter}`;

    if (info.didEquipSlotIncrease) {
        slotText.textContent =
            `スキル装備枠が増えました！ ${info.slotsBefore}枠 → ${info.slotsAfter}枠`;
    } else {
        const nextInfo = getNextEquipSlotUnlockInfo(info.levelAfter);
        slotText.textContent = nextInfo
            ? `次の装備枠解放：Lv${nextInfo.nextLevel}で${nextInfo.nextSlots}枠`
            : '装備枠は最大です';
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
        maxRate: Number.isFinite(data?.maxRate)
            ? data.maxRate
            : calculateEffectiveRate(
                Number.isFinite(data?.rate) ? data.rate : 1500,
                Number.isFinite(data?.ratedMatches) ? data.ratedMatches : 0
            ),
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
        maxRate: Number.isFinite(targetPlayer.maxRate)
            ? targetPlayer.maxRate
            : calculateEffectiveRate(
                Number.isFinite(targetPlayer.rate) ? targetPlayer.rate : 1500,
                Number.isFinite(targetPlayer.ratedMatches) ? targetPlayer.ratedMatches : 0
            ),
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
    player.maxRate = data.maxRate;
    player.ratedMatches = data.ratedMatches;
    player.ratedWins = data.ratedWins;
    player.ratedLosses = data.ratedLosses;
    player.ratedDraws = data.ratedDraws;
    player.lastRatedBattleAt = data.lastRatedBattleAt;
    player.initialSetupCompleted = data.initialSetupCompleted;
    cleanupEquippedSkills(player);
    // プレリリース版では全スキル解放のため、ロード後に全スキルを付与する。
    unlockAllSkills(player);
    // ロード直後は「保存済み」と見なしてスナップショットを記録する
    lastSavedPlayerData = clonePlayerSnapshot(player);
}

// 前回保存済みデータとの差分チェック。変更があれば true を返す。
function hasPlayerDataChanged(before, after) {
    if (!before) return true;
    const fields = [
        'name', 'style', 'atk', 'def', 'spd', 'tec', 'sta',
        'exp', 'usableExp', 'level', 'wins', 'losses',
        'skills', 'equippedSkills',
        'rate', 'ratedMatches', 'ratedWins', 'ratedLosses', 'ratedDraws', 'maxRate'
    ];
    for (const field of fields) {
        if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
            return true;
        }
    }
    return false;
}

/**
 * 差分チェックに必要なフィールドのみをコピーしたスナップショットを返す。
 * Firestore Timestamp など structuredClone 非対応の値を含むフィールドは除外する。
 */
function clonePlayerSnapshot(targetPlayer) {
    return {
        name: targetPlayer.name,
        style: targetPlayer.style,
        atk: targetPlayer.atk,
        def: targetPlayer.def,
        spd: targetPlayer.spd,
        tec: targetPlayer.tec,
        sta: targetPlayer.sta,
        exp: targetPlayer.exp,
        usableExp: targetPlayer.usableExp,
        level: targetPlayer.level,
        wins: targetPlayer.wins,
        losses: targetPlayer.losses,
        skills: Array.isArray(targetPlayer.skills) ? [...targetPlayer.skills] : [],
        equippedSkills: Array.isArray(targetPlayer.equippedSkills) ? [...targetPlayer.equippedSkills] : [],
        rate: targetPlayer.rate,
        ratedMatches: targetPlayer.ratedMatches,
        ratedWins: targetPlayer.ratedWins,
        ratedLosses: targetPlayer.ratedLosses,
        ratedDraws: targetPlayer.ratedDraws,
        maxRate: targetPlayer.maxRate
    };
}

// 変更がある場合のみFirestoreへ保存する共通関数
async function savePlayerDataIfChanged(saveLabel = '保存中...') {
    if (!hasPlayerDataChanged(lastSavedPlayerData, player)) {
        console.log(`Firestore write skipped (${saveLabel}): no changes detected (total writes: ${debugFirestoreWriteCount})`);
        updateSaveStatus('変更なし（保存スキップ）');
        return true;
    }
    return savePlayerData(saveLabel);
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

        debugFirestoreWriteCount++;
        console.log(`Firestore write count: ${debugFirestoreWriteCount} (${saveLabel})`);
        lastSavedPlayerData = clonePlayerSnapshot(player);

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
        savePlayerDataIfChanged(label).catch(error => {
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
        // バトルログはFirestoreに保存しない（書き込み量削減のため）。
        // ログはメモリ上（battleLines）に保持され、バトル結果画面の表示には引き続き利用される。
        // Firestoreには最小限のサマリーのみ保存する。
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
            rateChange: Number.isFinite(matchResult.rateChange) ? matchResult.rateChange : null,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        debugFirestoreWriteCount++;
        console.log(`Firestore write count: ${debugFirestoreWriteCount} (match result)`);
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

        debugFirestoreWriteCount++;
        console.log(`Firestore write count: ${debugFirestoreWriteCount} (new player created)`);
        lastSavedPlayerData = clonePlayerSnapshot(player);

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
    maxRate: 1000,
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
    tournament: '大会モード',
    rated: '全国Rate対戦'
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

    // プレリリース版では全スキル解放のため、skills 配列によるフィルタは行わない。
    return targetPlayer.equippedSkills
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

function getNextEquipSlotUnlockInfo(level) {
    if (level < 5) {
        return { nextLevel: 5, nextSlots: 3 };
    }
    if (level < 10) {
        return { nextLevel: 10, nextSlots: 4 };
    }
    if (level < 20) {
        return { nextLevel: 20, nextSlots: 5 };
    }
    return null;
}

function getLevelEquipSlotSummary(targetPlayer) {
    const level = Number.isFinite(targetPlayer.level) ? targetPlayer.level : 1;
    const currentSlots = getMaxEquipSlots(level);
    const nextInfo = getNextEquipSlotUnlockInfo(level);

    return {
        level,
        currentSlots,
        nextInfo,
        mainText: `Lv ${level}　装備枠 ${currentSlots}`,
        nextText: nextInfo
            ? `次の装備枠解放：Lv${nextInfo.nextLevel}で${nextInfo.nextSlots}枠`
            : '装備枠は最大です'
    };
}

function getEquippedSkillCount(targetPlayer) {
    ensurePlayerEquippedSkills(targetPlayer);
    return targetPlayer.equippedSkills.length;
}

function ensurePlayerSkills(targetPlayer) {
    if (!Array.isArray(targetPlayer.skills)) {
        targetPlayer.skills = [];
    }
}

function hasSkill(targetPlayer, skillId) {
    // プレリリース版では全スキル解放のため、スキルが存在するIDであれば所持扱いとする。
    // targetPlayer は将来の収集要素復活に備えて引数として残す（後方互換性）。
    return Boolean(getSkillById(skillId));
}

// プレリリース版ではスキル全解放のため、ランダム獲得機能はUIから非表示。
// 将来的な収集要素復活に備えて関数は残す。
function unlockAllSkills(targetPlayer) {
    ensurePlayerSkills(targetPlayer);
    const ownedSet = new Set(targetPlayer.skills);
    for (const skill of skillCards) {
        if (!ownedSet.has(skill.id)) {
            targetPlayer.skills.push(skill.id);
            ownedSet.add(skill.id);
        }
    }
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
    // スキル獲得時の個別保存は廃止。呼び出し元が保存責任を持つ:
    //  - 育成画面（setupTrainingButtons / spendExpForRandomSkill）: 画面遷移時に一括保存
    //  - 初回セットアップ（completeInitialSetup*）: autoSavePlayer('initial_setup') で保存
    //  - 試合終了時（applyMatchResult / startTournament）: autoSavePlayer('match_finished') で保存
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

    // プレリリース版では全スキル解放のため、所持チェックは省略。

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

// プレリリース版ではスキル全解放のため、ランダム獲得機能はUIから非表示。
// 将来的な収集要素復活に備えて関数は残す。
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
    const equippedSkills = getEquippedSkillObjects(targetPlayer);
    let bonus = 0;

    equippedSkills.forEach(skill => {
        const effects = skill.effects || {};

        if (effects.finishRate) {
            bonus += 0.03;
        }

        if (effects.attackChainRate) {
            bonus += 0.03;
        }

        if (effects.counterRate) {
            bonus += 0.04;
        }

        if (effects.counterEventRate) {
            bonus += 0.03;
        }

        if (effects.enemyMistakeRate) {
            bonus += 0.03;
        }

        if (context.isDisadvantage && effects.comebackEventRate) {
            bonus += 0.05;
        }

        if (effects.randomRangeRate) {
            bonus += 0.02;
        }

        if (effects.enemyFinishRate) {
            bonus += 0.03;
        }
    });

    return clamp(bonus, -0.08, 0.10);
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

    return ['練習試合を開始した。', `${enemy.name}と対戦する。`];
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

    if (mode === 'rated') {
        return result === 'win' ? 40 : 20;
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
    const pointMatch = simulatePointMatch(finalWinRate);
    const isPlayerWin = pointMatch.isPlayerWin;

    const advantageBreakdown = {
        baseRate,
        baseAdvantage: baseRate - 0.5,
        matchupBonus: adjustedMatchupModifier,
        skillBonus: skillWinRateBonus + skillBattleBonus,
        skillWinRateBonus,
        skillBattleBonus,
        tacticBonus: tacticWinRateBonus,
        pointWinRate: finalWinRate
    };

    const battleLines = [
        ...generateModeStartLog(mode, enemy),
        ...(roundIndex !== null ? [`大会 第${roundIndex + 1}試合`] : []),
        ...generateTacticLog(tacticId),
        ...buildBattleLogLines(isPlayerWin, player.style, enemy.style, generateSkillBattleLogs(player, context), player.name, enemy.name)
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
        advantageBreakdown,
        pointMatch,
        playerScore: pointMatch.playerScore,
        enemyScore: pointMatch.enemyScore,
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
    const nameEl = document.getElementById('playerName');
    if (nameEl) {
        nameEl.textContent = player.name;
    }
    const levelEl = document.getElementById('playerLevel');
    if (levelEl) {
        levelEl.textContent = `Lv ${player.level}`;
    }

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
// 【原因と対策】c8cfe4e（HOME画面の選手情報削除）で statAtk 等の要素が
// index.html から削除されたが、この関数の getElementById 呼び出しに null
// チェックが漏れていたため、戻り値が null の場合に TypeError が発生していた。
// TypeError は renderAll() → initGame() を経由して伝播し、
// setupNavButtons() が呼ばれないままとなり、すべてのメニューボタンで
// 画面遷移が機能しなくなっていた（ディグレード）。
// 対策: renderTrainingScreen() と同様に、要素が存在する場合のみ更新する
// null ガードを追加した。また バー幅が 100% を超えないよう Math.min(100, ...)
// でクランプしている（renderTrainingScreen と同じ実装）。
function updateStats() {
    const maxStat = 50;
    const statKeys = ['Atk', 'Def', 'Spd', 'Tec', 'Sta'];
    statKeys.forEach(label => {
        const key = label.toLowerCase();
        const valEl = document.getElementById('stat' + label);
        if (valEl) {
            valEl.textContent = player[key];
        }
        const barEl = document.getElementById(key + 'Bar');
        if (barEl) {
            barEl.style.width = Math.min(100, (player[key] / maxStat * 100)) + '%';
        }
    });
}

// ============================================================
// 戦型情報を表示
function updateStyleInfo() {
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

function renderHomeScreen() {
    renderLevelEquipSlotInfo('home', player);
}

function renderLevelEquipSlotInfo(prefix, targetPlayer) {
    const summary = getLevelEquipSlotSummary(targetPlayer);
    const equippedCount = getEquippedSkillCount(targetPlayer);

    const levelEl = document.getElementById(`${prefix}PlayerLevel`);
    if (levelEl) {
        levelEl.textContent = `Lv ${summary.level}`;
    }

    const slotsEl = document.getElementById(`${prefix}EquipSlots`);
    if (slotsEl) {
        slotsEl.textContent = `${equippedCount} / ${summary.currentSlots}`;
    }

    const nextEl = document.getElementById(`${prefix}NextEquipSlot`);
    if (nextEl) {
        nextEl.textContent = summary.nextText;
    }
}

function renderUnifiedSkillList() {
    const container = document.getElementById('unifiedSkillList');
    if (!container) {
        return;
    }

    // プレリリース版では全スキル解放のため、未取得表示は行わない。
    const itemsHtml = skillCards.map(skill => {
        const equipped = isSkillEquipped(player, skill.id);

        return `
            <div class="skill-card ${equipped ? 'equipped' : ''}">
                <div class="skill-title-row">
                    <span class="skill-name">${skill.name}</span>
                    <span class="skill-category">${skill.category}</span>
                    ${equipped ? '<span class="skill-equipped-badge">装備中</span>' : ''}
                </div>
                <div class="skill-description">${skill.description}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = itemsHtml;
}

function renderPreBattleSkillList(containerId, infoId) {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

    const maxSlots = getMaxEquipSlots(player.level);
    ensurePlayerEquippedSkills(player);
    const equippedCount = player.equippedSkills.length;

    const infoElement = document.getElementById(infoId);
    if (infoElement) {
        infoElement.textContent = `装備中 ${equippedCount} / ${maxSlots}`;
    }

    // プレリリース版では全スキル解放のため、全スキルカードから選択できる。
    const availableSkills = skillCards;

    const isFulfilled = equippedCount >= maxSlots;
    const promptHtml = `<div class="pre-battle-skill-prompt${isFulfilled ? ' fulfilled' : ''}">
        ${isFulfilled
            ? `✅ ${equippedCount}枚選択済み`
            : `⚠️ スキルカードを選択してください（${equippedCount} / ${maxSlots}）`}
    </div>`;

    const chipsHtml = availableSkills.map(skill => {
        const equipped = isSkillEquipped(player, skill.id);
        const canSelect = !equipped && equippedCount < maxSlots;
        const shouldDisable = !equipped && !canSelect;
        return `<button class="skill-select-chip${equipped ? ' selected' : ''}" data-skill-id="${skill.id}"${shouldDisable ? ' disabled' : ''}>${skill.name}</button>`;
    }).join('');

    container.innerHTML = `${promptHtml}<div class="pre-battle-skill-chips">${chipsHtml}</div>`;
}

// Backward-compatibility wrapper: the unified skill list replaces the old
// separate owned/equipped lists, so this function now delegates to renderUnifiedSkillList().
function renderOwnedSkills() {
    renderUnifiedSkillList();
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

    const trainingStyleDesc = document.getElementById('trainingStyleDesc');
    if (trainingStyleDesc) {
        trainingStyleDesc.textContent = player.style !== null ? styles[player.style].description : '';
    }

    const trainingPlayerExp = document.getElementById('trainingPlayerExp');
    if (trainingPlayerExp) {
        trainingPlayerExp.textContent = `${player.exp} / 使用可: ${player.usableExp}`;
    }

    renderStatRows('trainingStatList', player);
    renderTrainingCompleteCard();

    // プレリリース版ではランダムスキル獲得ボタンはHTMLで非表示。
    // ボタンが存在しても何もしない。

    renderLevelEquipSlotInfo('training', player);
}

function renderDataScreen() {
    // 全国Rate対決戦績
    const displayRate = calculateEffectiveRate(player.rate, player.ratedMatches);
    const dataRate = document.getElementById('dataRate');
    if (dataRate) {
        dataRate.textContent = displayRate;
    }

    const dataMaxRate = document.getElementById('dataMaxRate');
    if (dataMaxRate) {
        const maxRate = Number.isFinite(player.maxRate)
            ? player.maxRate
            : calculateEffectiveRate(player.rate || 1500, player.ratedMatches || 0);
        dataMaxRate.textContent = `(最高: ${maxRate})`;
    }

    const ratedMatches = player.ratedMatches || 0;
    const ratedWins = player.ratedWins || 0;
    const ratedLosses = player.ratedLosses || 0;

    const dataRatedMatches = document.getElementById('dataRatedMatches');
    if (dataRatedMatches) {
        dataRatedMatches.textContent = ratedMatches;
    }

    const dataRatedWins = document.getElementById('dataRatedWins');
    if (dataRatedWins) {
        dataRatedWins.textContent = ratedWins;
    }

    const dataRatedLosses = document.getElementById('dataRatedLosses');
    if (dataRatedLosses) {
        dataRatedLosses.textContent = ratedLosses;
    }

    const dataRatedWinRate = document.getElementById('dataRatedWinRate');
    if (dataRatedWinRate) {
        const decidedMatches = ratedWins + ratedLosses;
        dataRatedWinRate.textContent = decidedMatches > 0
            ? `${(ratedWins / decidedMatches * 100).toFixed(1)}%`
            : '-';
    }

    // CPU対戦戦績
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

    renderStatRows('dataStatList', player);
}

function renderAll() {
    updatePlayerInfo();
    updateStats();
    updateStyleInfo();
    renderUnifiedSkillList();
    renderTactics();
    renderRivals();
    updateCurrentModeLabel(currentBattleMode);
    renderCharacters();
    renderSettings();
    renderHomeScreen();
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
    const numSkills = randomInt(1, 2);
    const shuffled = [...skillCards].sort(() => Math.random() - 0.5);
    const cpuSkills = shuffled.slice(0, numSkills).map(s => s.id);
    return {
        name: `CPU-${randomInt(100, 999)}`,
        style: styleId,
        atk: randomInt(Math.max(8, targetPlayer.atk - 3), targetPlayer.atk + 3),
        def: randomInt(Math.max(8, targetPlayer.def - 3), targetPlayer.def + 3),
        spd: randomInt(Math.max(8, targetPlayer.spd - 3), targetPlayer.spd + 3),
        tec: randomInt(Math.max(8, targetPlayer.tec - 3), targetPlayer.tec + 3),
        sta: randomInt(Math.max(8, targetPlayer.sta - 3), targetPlayer.sta + 3),
        skills: cpuSkills,
        equippedSkills: cpuSkills
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

function simulateGamePoints(perPointRate, firstServerIsPlayer, playerStyleName, cpuStyleName, playerName, cpuName) {
    const actions = ['サーブ', 'レシーブ', 'ドライブ', 'ブロック', 'カウンター', 'カット', 'スマッシュ'];
    const momentumWords = ['主導権を握る', 'ラリーを制する', '粘り勝つ', 'ミスを誘う', '角度を突く'];
    const lines = [];
    let playerScore = 0;
    let cpuScore = 0;
    let totalPointsPlayed = 0;
    let deuceNotified = false;

    const firstServerName = firstServerIsPlayer ? playerName : cpuName;
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
        const pointWinner = playerWinsPoint ? playerName : cpuName;
        const styleName = playerWinsPoint ? playerStyleName : cpuStyleName;
        const serverName = currentServerIsPlayer ? playerName : cpuName;

        lines.push(`[${playerScore}-${cpuScore}] ${serverName}のサーブ。${styleName}の${action}。${pointWinner}が${momentum}。`);

        if (Math.max(playerScore, cpuScore) >= 11 && Math.abs(playerScore - cpuScore) >= 2) {
            break;
        }
    }

    return { lines, playerScore, cpuScore };
}

/**
 * 1点ごとの得点確率を使って11点先取・デュースありの試合をシミュレートする。
 * @param {number} pointWinRate - プレイヤーが1点を取る確率（0〜1）
 * @param {object} [options]
 * @param {number} [options.targetScore=11] - 先取点数
 * @param {number} [options.requiredDiff=2] - 勝利に必要な点差
 * @param {number} [options.maxScore=30] - 極端な長期デュース防止のための最大スコア上限
 * @returns {{isPlayerWin: boolean, playerScore: number, enemyScore: number, pointResults: Array}}
 */
function simulatePointMatch(pointWinRate, options = {}) {
    const targetScore = options.targetScore || 11;
    const requiredDiff = options.requiredDiff || 2;
    const maxScore = options.maxScore || 30;

    let playerScore = 0;
    let enemyScore = 0;
    const pointResults = [];

    while (true) {
        const isPlayerPoint = Math.random() < pointWinRate;

        if (isPlayerPoint) {
            playerScore += 1;
        } else {
            enemyScore += 1;
        }

        pointResults.push({
            playerScore,
            enemyScore,
            winner: isPlayerPoint ? 'player' : 'enemy'
        });

        const reachedTarget = playerScore >= targetScore || enemyScore >= targetScore;
        const scoreDiff = Math.abs(playerScore - enemyScore);

        if (reachedTarget && scoreDiff >= requiredDiff) {
            break;
        }

        // 極端な長期デュース防止
        if (playerScore >= maxScore || enemyScore >= maxScore) {
            break;
        }
    }

    return {
        isPlayerWin: playerScore > enemyScore,
        playerScore,
        enemyScore,
        pointResults
    };
}

function buildBattleLogLines(isPlayerWin, playerStyleId, cpuStyleId, skillLogLines, playerName, cpuName) {
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
        result = simulateGamePoints(perPointRate, firstServerIsPlayer, playerStyleName, cpuStyleName, playerName, cpuName);
        attempts++;
    } while ((result.playerScore > result.cpuScore) !== isPlayerWin && attempts < 20);

    const lines = result.lines;

    skillLogLines.forEach(log => {
        lines.push(`スキル: ${log}`);
    });

    const finalScore = `${result.playerScore}-${result.cpuScore}`;
    lines.push(isPlayerWin
        ? `最終スコア ${finalScore}: ${playerName}の勝利！`
        : `最終スコア ${finalScore}: ${cpuName}の勝利...`);
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

function buildPostMatchAnalysis(result, targetPlayer) {
    const isWin = result.isPlayerWin;
    const matchup = Number.isFinite(result.adjustedMatchupModifier)
        ? result.adjustedMatchupModifier
        : 0;

    const isAdvantage = matchup > 0.05;
    const isDisadvantage = matchup < -0.05;

    const tactic = getTacticById(result.tacticId);
    const equippedSkills = getEquippedSkillObjects(targetPlayer);
    const featuredSkill = equippedSkills[0] || null;

    const playerDisplayRate = Number.isFinite(result.displayRateBefore) ? result.displayRateBefore : null;
    const cpuDisplayRate = result.cpu
        ? (Number.isFinite(result.cpu.displayRate) ? result.cpu.displayRate
            : Number.isFinite(result.cpu.rate) ? result.cpu.rate : null)
        : null;
    const rateDiff = (playerDisplayRate !== null && cpuDisplayRate !== null)
        ? cpuDisplayRate - playerDisplayRate
        : null;
    const isHigherRated = rateDiff !== null && rateDiff > 50;
    const isLowerRated = rateDiff !== null && rateDiff < -50;

    let resultComment;
    let keyPoint;
    let nextAdvice;

    if (isWin) {
        if (isHigherRated) {
            resultComment = '格上相手に勝利！スキルと作戦が噛み合った会心の一戦でした。';
        } else if (isAdvantage) {
            resultComment = '戦型相性を活かして、試合の主導権を握りました。';
        } else if (isDisadvantage) {
            resultComment = '不利相性の中でも、スキルと作戦で展開を立て直しました。';
        } else {
            resultComment = '自分の持ち味を活かして、勝ち切ることができました。';
        }
    } else {
        if (isLowerRated) {
            resultComment = '取りこぼしの悔しい敗戦です。次は安定重視で勝ち切りたいところです。';
        } else if (isDisadvantage) {
            resultComment = '戦型相性の悪さが出た試合でした。';
        } else if (isAdvantage) {
            resultComment = '有利な展開を作れましたが、勝負所で取り切れませんでした。';
        } else {
            resultComment = '互角の展開でしたが、最後は相手に流れを取られました。';
        }
    }

    if (featuredSkill) {
        keyPoint = isWin
            ? `装備スキル「${featuredSkill.name}」が勝負所で効きました。`
            : `装備スキル「${featuredSkill.name}」を活かし切るには、作戦との組み合わせを見直す余地があります。`;
    } else if (tactic) {
        keyPoint = `作戦「${tactic.name}」が試合展開に影響しました。`;
    } else {
        keyPoint = '育成・スキル・作戦の組み合わせが勝敗に影響します。';
    }

    if (!isWin && isDisadvantage) {
        nextAdvice = '次は「相性対策」を選ぶと、展開が変わるかもしれません。';
    } else if (!isWin && tactic?.id === 'power') {
        nextAdvice = '次は「安定重視」を選ぶと、取りこぼしを減らせそうです。';
    } else if (isWin && isHigherRated) {
        nextAdvice = '今の構成を軸に、さらに格上の相手にも挑戦してみましょう。';
    } else if (isWin) {
        nextAdvice = '今の構成を軸に、相手戦型に応じて作戦を調整してみましょう。';
    } else {
        nextAdvice = '次の試合では、スキル構成や作戦を少し変えてみましょう。';
    }

    return {
        resultComment,
        keyPoint,
        nextAdvice
    };
}

function applyMatchResult(result) {
    const expGained = calculateExpReward(result.mode, result.result, result);

    if (result.result === 'win') {
        player.wins += 1;
    } else {
        player.losses += 1;
    }

    const levelBefore = player.level;
    const slotsBefore = getMaxEquipSlots(levelBefore);

    awardExp(expGained);

    const levelAfter = player.level;
    const slotsAfter = getMaxEquipSlots(levelAfter);

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
        log: result.battleLines,
        rateChange: Number.isFinite(result.rateChange) ? result.rateChange : null
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
        playerScore: Number.isFinite(result.playerScore) ? result.playerScore : null,
        enemyScore: Number.isFinite(result.enemyScore) ? result.enemyScore : null,
        expGained,
        battleLines: result.battleLines,
        playerLevel: player.level,
        playerExp: player.exp,
        playerWins: player.wins,
        playerLosses: player.losses,
        mode: result.mode || 'practice',
        rateChange: Number.isFinite(result.rateChange) ? result.rateChange : null,
        displayRateBefore: Number.isFinite(result.displayRateBefore) ? result.displayRateBefore : null,
        displayRateAfter: Number.isFinite(result.displayRateAfter) ? result.displayRateAfter : null,
        ratedMatchesAfter: Number.isFinite(result.ratedMatchesAfter) ? result.ratedMatchesAfter : null,
        advantageBreakdown: result.advantageBreakdown || null,
        postMatchAnalysis: buildPostMatchAnalysis(result, player),
        levelUpInfo: {
            levelBefore,
            levelAfter,
            slotsBefore,
            slotsAfter,
            didLevelUp: levelAfter > levelBefore,
            didEquipSlotIncrease: slotsAfter > slotsBefore
        }
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

    const levelBefore = player.level;
    const slotsBefore = getMaxEquipSlots(levelBefore);

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

    const levelAfter = player.level;
    const slotsAfter = getMaxEquipSlots(levelAfter);

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
        playerLosses: player.losses,
        levelUpInfo: {
            levelBefore,
            levelAfter,
            slotsBefore,
            slotsAfter,
            didLevelUp: levelAfter > levelBefore,
            didEquipSlotIncrease: slotsAfter > slotsBefore
        }
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

            const cap = getStatCap(player.style, stat);
            if (player[stat] >= cap) {
                addLog(`${getStatDisplayName(stat)}はこの戦型の上限（${cap}）に達しています。`, 'warning');
                return;
            }

            if (player.usableExp < expCost) {
                addLog(`${stat.toUpperCase()}の強化には${expCost}EXPが必要です。現在: ${player.usableExp}EXP`, 'warning');
                return;
            }

            player.usableExp -= expCost;
            player[stat] = Math.min(cap, player[stat] + 1);
            // 育成ボタンクリックごとの個別保存は廃止。画面遷移時に一括保存する。

            player.level += 1;

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

function setupSkillAcquisitionButton() {
    const btn = document.getElementById('buyRandomSkillBtn');
    if (!btn) {
        return;
    }

    btn.addEventListener('click', function() {
        spendExpForRandomSkill();
    });
}

// プレリリース版ではスキル全解放のため、ランダム獲得機能はUIから非表示。
// 将来的な収集要素復活に備えて関数は残す。
function spendExpForRandomSkill() {
    const expCost = 100;
    const expReturn = 50;

    if (player.usableExp < expCost) {
        addLog(`ランダムスキル獲得には${expCost}EXPが必要です。現在: ${player.usableExp}EXP`, 'warning');
        return;
    }

    // 全スキルからランダムに1枚選ぶ（所持済みを含む）
    const randomIndex = Math.floor(Math.random() * skillCards.length);
    const pickedSkill = skillCards[randomIndex];

    if (hasSkill(player, pickedSkill.id)) {
        // ハズレ: 50EXP返還（実質50EXP消費）
        player.usableExp -= (expCost - expReturn);
        addLog(`ハズレ！スキル「${pickedSkill.name}」はすでに所持しています。EXP ${expReturn} 返還（実質${expCost - expReturn}EXP消費）`, 'warning');
    } else {
        player.usableExp -= expCost;
        // addSkillToPlayer が獲得ログを出すので追加メッセージは不要
        addSkillToPlayer(player, pickedSkill.id);
    }

    updateStats();
    updatePlayerInfo();
    renderTrainingScreen();
    updateSkillUI();
}

function setupSkillButtons() {
    const unifiedListElement = document.getElementById('unifiedSkillList');

    if (unifiedListElement) {
        unifiedListElement.addEventListener('click', function(event) {
            const target = event.target;
            if (target.classList.contains('equip-skill-btn')) {
                const skillId = target.getAttribute('data-skill-id');
                equipSkill(player, skillId);
            } else if (target.classList.contains('unequip-skill-btn')) {
                const skillId = target.getAttribute('data-skill-id');
                unequipSkill(player, skillId);
            }
        });
    }

    // Legacy: keep handlers for old list elements in case they exist
    const ownedListElement = document.getElementById('ownedSkillList');
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

    const equippedListElement = document.getElementById('equippedSkillList');
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

function setupPreBattleSkillButtons() {
    const containers = [
        { listId: 'bsPlayerSkillList', infoId: 'bsEquipSlotsInfo' },
        { listId: 'ratedPlayerSkillList', infoId: 'ratedEquipSlotsInfo' }
    ];

    containers.forEach(({ listId, infoId }) => {
        const container = document.getElementById(listId);
        if (!container) {
            return;
        }

        container.addEventListener('click', function(event) {
            const target = event.target;
            if (target.classList.contains('skill-select-chip')) {
                const skillId = target.getAttribute('data-skill-id');
                if (isSkillEquipped(player, skillId)) {
                    unequipSkill(player, skillId);
                } else {
                    equipSkill(player, skillId);
                }
                renderPreBattleSkillList(listId, infoId);
            }
        });
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
        const cpu = battleStartCpu;
        battleStartCpu = null; // 試合開始後はフォーフィット対象外にする
        const result = simulateBattleWithOptions({
            mode: 'practice',
            tacticId: selectedTacticId,
            enemy: cpu || undefined
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
            if (lastBattleResult && lastBattleResult.mode === 'rated') {
                changeScreen('ratedBattleStart');
            } else {
                changeScreen('battleStart');
            }
        });
    }
}

function buildShareText(result) {
    const lines = [];

    const playerStyle = result.playerStyle || '未選択';
    const enemyStyle = result.cpuStyle || '相手';
    const isWin = result.isPlayerWin;
    const resultText = isWin ? 'WIN' : 'LOSE';

    lines.push('🏓 Table Tennis Skills Battle');
    lines.push('');
    lines.push(`戦型：${playerStyle}`);
    lines.push(`結果：${resultText}`);

    // バトルログから最終スコアを抽出する
    const scoreLine = Array.isArray(result.battleLines)
        ? result.battleLines.find(line => line.startsWith('最終スコア '))
        : null;
    if (scoreLine) {
        const m = scoreLine.match(/最終スコア (\d+)-(\d+)/);
        if (m) {
            lines.push(`スコア：${m[1]} - ${m[2]}`);
        }
    }

    if (result.mode === 'rated') {
        const before = result.displayRateBefore;
        const after = result.displayRateAfter;
        const change = result.rateChange;

        if (Number.isFinite(before) && Number.isFinite(after) && Number.isFinite(change)) {
            const sign = change >= 0 ? '+' : '';
            lines.push(`Rate：${before} → ${after}（${sign}${change}）`);
        }
    }

    if (enemyStyle) {
        lines.push(`相手：${enemyStyle}`);
    }

    const analysis = result.postMatchAnalysis;
    if (analysis && analysis.keyPoint) {
        lines.push('');
        lines.push(`勝因/敗因：${analysis.keyPoint}`);
    } else if (analysis && analysis.resultComment) {
        lines.push('');
        lines.push(analysis.resultComment);
    }

    lines.push('');
    lines.push('育てろ、君だけの戦型。');
    lines.push('#卓球 #卓球ゲーム #TableTennisSkillsBattle');

    return lines.join('\n');
}

function buildXShareUrl(text) {
    const encodedText = encodeURIComponent(truncateShareText(text));
    return `https://x.com/intent/tweet?text=${encodedText}`;
}

function truncateShareText(text, maxLength = 280) {
    if (text.length <= maxLength) {
        return text;
    }
    return text.slice(0, maxLength - 1) + '…';
}

function setupShareButtons() {
    const shareBtn = document.getElementById('shareXBtn');

    if (!shareBtn) {
        return;
    }

    shareBtn.addEventListener('click', () => {
        if (!lastBattleResult) {
            return;
        }

        const text = buildShareText(lastBattleResult);
        const url = buildXShareUrl(text);
        window.open(url, '_blank', 'noopener,noreferrer');
    });
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

// ステータス上限を返す（戦型未選択時はfallbackを使用）
function getStatCap(styleId, stat) {
    const fallbackCaps = { atk: 110, def: 110, spd: 110, tec: 110, sta: 110 };
    const caps = STYLE_STAT_CAPS[styleId] || fallbackCaps;
    return caps[stat] || fallbackCaps[stat] || 110;
}

// ステータス表示名を返す
function getStatDisplayName(stat) {
    const names = {
        atk: '攻撃力',
        def: '守備力',
        spd: 'スピード',
        tec: '技術',
        sta: 'スタミナ'
    };
    return names[stat] || stat;
}

// 上限値に応じた得意/苦手ラベルを返す
function getStatTraitLabel(cap) {
    if (cap >= 125) return '超得意';
    if (cap >= 115) return '得意';
    if (cap >= 100) return '標準';
    if (cap >= 90) return 'やや苦手';
    return '苦手';
}

// 上限値に応じたCSSクラスを返す
function getStatTraitClass(cap) {
    if (cap >= 125) return 'trait-very-good';
    if (cap >= 115) return 'trait-good';
    if (cap >= 100) return 'trait-normal';
    if (cap >= 90) return 'trait-weak';
    return 'trait-very-weak';
}

// 表示用ステータス値（上限で丸める）
function getDisplayStatValue(targetPlayer, stat) {
    const cap = getStatCap(targetPlayer.style, stat);
    return Math.min(targetPlayer[stat], cap);
}

// 全ステータスが上限に達しているか判定する
function isAllStatsCapped(targetPlayer) {
    const stats = ['atk', 'def', 'spd', 'tec', 'sta'];
    return stats.every(stat => {
        const cap = getStatCap(targetPlayer.style, stat);
        return targetPlayer[stat] >= cap;
    });
}

// 育成完成カードの表示/非表示を更新する
function renderTrainingCompleteCard() {
    const card = document.getElementById('trainingCompleteCard');
    if (!card) {
        return;
    }
    card.style.display = isAllStatsCapped(player) ? '' : 'none';
}

// ステータス行一覧をコンテナに描画する
function renderStatRows(containerId, targetPlayer) {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }
    const stats = [
        { key: 'atk', code: 'ATK' },
        { key: 'def', code: 'DEF' },
        { key: 'spd', code: 'SPD' },
        { key: 'tec', code: 'TEC' },
        { key: 'sta', code: 'STA' }
    ];
    container.innerHTML = stats.map(({ key, code }) => {
        const cap = getStatCap(targetPlayer.style, key);
        const displayVal = getDisplayStatValue(targetPlayer, key);
        const percent = Math.min(100, (displayVal / cap * 100));
        const traitLabel = getStatTraitLabel(cap);
        const traitClass = getStatTraitClass(cap);
        const name = getStatDisplayName(key);
        return `<div class="stat-row">
  <div class="stat-row-header">
    <span class="stat-code">${code}</span>
    <span class="stat-name">${name}</span>
    <span class="stat-number">${displayVal} / ${cap}</span>
    <span class="stat-trait ${traitClass}">${traitLabel}</span>
  </div>
  <div class="stat-bar"><div class="stat-bar-fill" style="width:${percent}%"></div></div>
</div>`;
    }).join('');
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
                        <button class="setup-style-btn" data-style="${style.id}">
                            <img class="style-mini-icon" src="${getRataCharacterImageSrc(style.name, 'normal')}" alt="">
                            <span class="style-btn-name">${style.name}</span>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function completeInitialSetup(name, styleIndex) {
    const validation = validatePlayerName(name);
    if (!validation.valid) {
        addLog(`選手名エラー: ${validation.message}`, 'warning');
        return;
    }
    player.name = validation.name;
    player.style = styleIndex;
    player.initialSetupCompleted = true;

    localStorage.setItem(LOCAL_SETUP_COMPLETE_KEY, '1');

    // 初期スキルカードを1枚付与する
    gainRandomSkill(player);

    hideSetupOverlay();
    renderAll();

    addLog(`選手名「${validation.name}」、戦型「${styles[styleIndex].name}」で初期設定完了！`, 'success');
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
        const nameError = document.getElementById('setupNameError');
        const result = validatePlayerName(nameInput.value);
        if (!result.valid) {
            nameInput.focus();
            nameInput.classList.add('setup-input-error');
            if (nameError) {
                nameError.textContent = result.message || 'この選手名は使用できません';
                nameError.style.display = 'block';
            }
            return;
        }
        nameInput.classList.remove('setup-input-error');
        if (nameError) {
            nameError.style.display = 'none';
        }
        setupPlayerName = result.name;
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
    const validation = validatePlayerName(name);
    if (!validation.valid) {
        addLog(`選手名エラー: ${validation.message}`, 'warning');
        return;
    }
    player.name = validation.name;
    player.style = styleIndex;
    player.initialSetupCompleted = true;

    localStorage.setItem(LOCAL_SETUP_COMPLETE_KEY, '1');

    // 初期スキルカードを1枚付与する
    gainRandomSkill(player);

    hideSetupOverlay();
    renderAll();

    addLog(`選手名「${validation.name}」、戦型「${styles[styleIndex].name}」で初期設定完了！`, 'success');
    autoSavePlayer('initial_setup');

    if (password && isFirebaseReady && db && currentPlayerId) {
        try {
            const hash = await hashPassword(password);
            await db.collection('players').doc(currentPlayerId).set({ passwordHash: hash }, { merge: true });
            debugFirestoreWriteCount++;
            console.log(`Firestore write count: ${debugFirestoreWriteCount} (initial password set)`);
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

function showTopScreen() {
    const topScreen = document.getElementById('top-screen');
    if (topScreen) {
        topScreen.style.display = 'block';
    }
}

function hideTopScreen() {
    const topScreen = document.getElementById('top-screen');
    if (topScreen) {
        topScreen.style.display = 'none';
    }
}

function setupStartButton() {
    const startBtn = document.getElementById('startBtn');
    if (!startBtn) {
        return;
    }
    startBtn.addEventListener('click', function() {
        hideTopScreen();
        showLoginOverlay();
    }, { once: true });
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
        debugFirestoreWriteCount++;
        console.log(`Firestore write count: ${debugFirestoreWriteCount} (password changed)`);
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
    setupSkillAcquisitionButton();
    setupPreBattleSkillButtons();
    setupBattleButton();
    setupConfirmStartBattleButton();
    setupTournamentButton();
    setupBattleModeSelectButtons();
    setupRatedBattleStartButtons();
    setupRatedBattleAnimationButtons();
    setupTacticSelect();
    setupRivalButtons();
    setupDebugSkillButton();
    setupManualSaveButton();
    setupBattleResultButtons();
    setupShareButtons();
    setupInitialSetupOverlay();
    setupLoginOverlay();
    setupChangePasswordModal();
    setupLogoutButton();
    setupNavButtons();
    setupStartButton();
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
        showTopScreen();
    }
}

window.addEventListener('DOMContentLoaded', initGame);
