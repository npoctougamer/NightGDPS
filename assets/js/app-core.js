const firebaseConfig = {
            apiKey: "AIzaSyBugYw3fPo4r7Q0e4jDjBUd-JBbCspghE8",
            authDomain: "mysterygdps-30547.firebaseapp.com",
            databaseURL: "https://mysterygdps-30547-default-rtdb.firebaseio.com",
            projectId: "mysterygdps-30547",
            storageBucket: "mysterygdps-30547.firebasestorage.app",
            messagingSenderId: "12553952733",
            appId: "1:12553952733:web:fa603d37c8c08dddefaa34",
            measurementId: "G-WVMTYWT40L"
        };
        firebase.initializeApp(firebaseConfig);
        const db = firebase.database();
        const auth = firebase.auth();

        let currentLang = 'RU';
        // Auth state — stored in closure to prevent trivial console override
        const _auth = (() => {
            let _isAdmin = false;
            let _isModerator = false;
            return {
                setMod(v)  { _isModerator = !!v; },
                setAdmin(v){ _isAdmin = !!v; if (!!v) _isModerator = true; },
                get isAdmin()     { return _isAdmin; },
                get isModerator() { return _isModerator; },
                reset() { _isAdmin = false; _isModerator = false; }
            };
        })();
        // Convenience shorthands used throughout the file — read-only getters
        Object.defineProperty(window, 'isAdmin',     { get: () => _auth.isAdmin,     set: () => {} });
        Object.defineProperty(window, 'isModerator', { get: () => _auth.isModerator, set: () => {} });
        let currentUserRole = null;
        let currentUserPermissions = {}; // Гранулярные п��ава текущего пользователя
        let isDeleteMode = false;
        let isEditMode = false;
        let isDragDropMode = false;
        // Фильтры списка уровней
        let filterState = { status: 'all', verified: false, newOnly: false, ptsMin: null, ptsMax: null };
        let filterPtsBounds = { min: 0, max: 1000 };
        const NEW_LEVEL_MS = 7 * 24 * 60 * 60 * 1000;
        let currentTab = 'demons';
        
        // Массивы данных
        let demons = [];
        let challenges = []; // Добавлен массив челленджей
        let creators = [];
        let moderators = [];
        let reviews = [];
        
        let selectedReviewRating = 0;
        let draggedItem = null;
        let draggedIndex = -1;

        // ===== Недавние изменения (в памяти, с момента загрузки страницы) =====
        let recentChanges = [];                       // [{kind:'add'|'move', type, key, name, pos, from, to, ts}]
        const _prevOrder = { demons: null, challenges: null };
        const RECENT_MAX = 40;

        // ===== Права на редактирование/перестановку по вкладке =====
        function canEditTab(tab) {
            if (isAdmin) return true;
            if (!isModerator) return false;
            if (tab === 'challenges') return !!currentUserPermissions.canAddChallenges;
            return !!currentUserPermissions.canAddDemons; // демоны
        }
        function canReorderCurrent() { return canEditTab(currentTab); }


        // Вход для команды доступен только через закрытую страницу modloginpage.
        // Обычным посетителям кнопка входа не показывается.

        // ===== AUTH STATE =====
        auth.onAuthStateChanged(async user => {
            _auth.reset();
            currentUserRole = null;
            currentUserPermissions = {};
            isDeleteMode = false;
            isEditMode = false;
            isDragDropMode = false;

            if (user) {
                try {
                    const modSnap = await db.ref('moderators/' + user.uid).once('value');
                    const modData = modSnap.val();
                    if (modData) {
                        currentUserRole = modData.role || 'moderator';
                        _auth.setMod(true);
                        _auth.setAdmin(currentUserRole === 'admin');
                        currentUserPermissions = currentUserRole === 'admin'
                            ? { canAddDemons: true, canAddChallenges: true, canAddRecords: true, canDeleteReviews: true }
                            : (modData.permissions || {});
                    } else {
                        // Обычный Firebase Auth аккаунт остаётся авторизованным как пользователь сайта.
                        currentUserRole = 'user';
                    }
                } catch (e) {
                    console.error('Role lookup failed:', e);
                    currentUserRole = 'user';
                }
            }

            updateUIForRole();
            if (window.NightAccounts && typeof window.NightAccounts.handleAuthState === 'function') {
                window.NightAccounts.handleAuthState(user);
            }
        });

        function updateUIForRole() {
            const trigger = document.getElementById('admin-trigger');
            const modTrigger = document.getElementById('mod-trigger');
            const modInd = document.getElementById('modIndicator');
            const modText = document.getElementById('modIndicatorText');

            if (isModerator) {
                localStorage.setItem('mxAdmin', '1');
                trigger.style.display = isAdmin ? 'block' : 'none';
                if (modTrigger) modTrigger.style.display = 'flex';
                modInd.style.display = 'flex';
                if (currentUserRole === 'admin') {
                    modText.textContent = 'Администратор';
                    modInd.style.color = '#f472b6';
                    modInd.style.borderColor = 'rgba(244,114,182,0.3)';
                    modInd.style.background = 'rgba(244,114,182,0.1)';
                } else {
                    modText.textContent = 'Модератор';
                    modInd.style.color = '#60a5fa';
                    modInd.style.borderColor = 'rgba(96,165,250,0.25)';
                    modInd.style.background = 'rgba(96,165,250,0.1)';
                }
                const user = auth.currentUser;
                if (user) {
                    const found = moderators.find(m => m.uid === user.uid);
                    const nick = found ? (found.nick || found.email) : (user.email || '');
                    const el = document.getElementById('modNickDisplay');
                    if (el) el.textContent = '\u{1F464} ' + nick;
                }
            } else {
                localStorage.removeItem('mxAdmin');
                // Посетители не должны видеть вход для команды.
                trigger.style.display = 'none';
                if (modTrigger) modTrigger.style.display = 'none';
                modInd.style.display = 'none';
            }
            if (window.NightAccounts && typeof window.NightAccounts.syncModeratorUI === 'function') window.NightAccounts.syncModeratorUI();
            render();
        }

        // Универсальная точка входа в панели команды.
        // Роль после входа по-прежнему проверяется безопасно по Firebase UID в /moderators.
        function openStaffAccess() {
            if (!isModerator) {
                openModLoginPage();
                return;
            }
            if (isAdmin) {
                openAdmin();
            } else {
                openModQuickPanel();
            }
        }

        db.ref('moderators').on('value', s => {
            const val = s.val();
            moderators = val ? Object.entries(val).map(([k, v]) => ({ uid: k, ...v })) : [];
            renderModList();
        });

        db.ref('reviews').on('value', s => {
            const val = s.val();
            reviews = val ? Object.entries(val).map(([k, v]) => ({ key: k, ...v })) : [];
            reviews.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            renderApprovedReviews();
            renderModReviews();
        });

        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str || '';
            return div.innerHTML;
        }

        // Исправляет битые символы (mojibake) при двойном перекодировании UTF-8 → Latin1 → UTF-8
        // ── Кнопка Наверх ──────────────────────────────────────────
        (function() {
            const btn = document.getElementById('backToTopBtn');
            window.addEventListener('scroll', () => {
                btn.classList.toggle('visible', window.scrollY > 320);
            }, { passive: true });
        })();

        // ── Сравнение игроков ────────────────────────────────────────
        function openCompareModal() {
            const modal = document.getElementById('compareModal');
            const selA  = document.getElementById('compareSelectA');
            const selB  = document.getElementById('compareSelectB');

            // Собираем список всех игроков из данных
            const playerSet = new Set();
            const collectNames = (level) => getLevelEntries(level).forEach(v => playerSet.add(v.name.trim()));
            demons.forEach(collectNames); challenges.forEach(collectNames);
            const sorted = Array.from(playerSet).sort((a,b) => a.localeCompare(b));

            const opts = sorted.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
            selA.innerHTML = opts;
            selB.innerHTML = opts;
            if (sorted.length > 1) selB.selectedIndex = 1;

            document.getElementById('compareResult').innerHTML = '';
            modal.style.display = 'block';
        }

        function getPlayerStats(playerName) {
            const allEntries = [];
            const collect = (level) => getLevelEntries(level).forEach(v => {
                if (v.name.trim().toLowerCase() === playerName.toLowerCase())
                    allEntries.push({ demon: level, victor: v });
            });
            demons.forEach(collect); challenges.forEach(collect);

            const getPerc = c => parseInt((c.victor.perc || '0').replace('%',''));
            const completions = allEntries.filter(c => getPerc(c) >= 100);
            const records     = allEntries.filter(c => { const p = getPerc(c); return p >= MIN_PERC && p < 100; });

            let pts = 0;
            allEntries.forEach(c => {
                const perc = getPerc(c);
                if (perc >= MIN_PERC) pts += calcPts(perc, c.demon.points);
            });

            // Ранк
            const playerMap = {};
            const ca = (level) => getLevelEntries(level).forEach(v => {
                const n = v.name.trim();
                if (!playerMap[n]) playerMap[n] = 0;
                const p = parseInt((v.perc||'0').replace('%',''));
                if (p >= MIN_PERC) playerMap[n] += calcPts(p, level.points);
            });
            demons.forEach(ca); challenges.forEach(ca);
            const rankSorted = Object.entries(playerMap).sort((a,b) => b[1]-a[1]);
            const rank = rankSorted.findIndex(([n]) => n.toLowerCase() === playerName.toLowerCase()) + 1;

            // Хардест
            let hardest = null;
            if (completions.length > 0) {
                const allList = [...demons, ...challenges];
                const withIdx = completions.map(c => ({ c, idx: allList.indexOf(c.demon) }));
                withIdx.sort((a,b) => a.idx - b.idx);
                hardest = withIdx[0].c.demon;
            }

            return { pts, rank, completions: completions.length, records: records.length, hardest };
        }

        function runCompare() {
            const nameA = document.getElementById('compareSelectA').value;
            const nameB = document.getElementById('compareSelectB').value;
            if (!nameA || !nameB || nameA === nameB) return;
            const T = currentLang === 'EN';
            const a = getPlayerStats(nameA);
            const b = getPlayerStats(nameB);

            const winnerA = a.pts >= b.pts;

            const row = (label, valA, valB, higherIsBetter = true) => {
                const aBetter = higherIsBetter ? valA > valB : valA < valB;
                const bBetter = higherIsBetter ? valB > valA : valB < valA;
                return `
                <div class="compare-stat-row">
                    <span class="compare-stat-label">${label}</span>
                    <span class="compare-stat-val ${aBetter ? 'better' : bBetter ? 'worse' : ''}" style="text-align:right;min-width:60px;">${valA}</span>
                </div>`;
            };
            const rowB = (label, valA, valB, higherIsBetter = true) => {
                const aBetter = higherIsBetter ? valA > valB : valA < valB;
                const bBetter = higherIsBetter ? valB > valA : valB < valA;
                return `
                <div class="compare-stat-row">
                    <span class="compare-stat-label">${label}</span>
                    <span class="compare-stat-val ${bBetter ? 'better' : aBetter ? 'worse' : ''}" style="text-align:right;min-width:60px;">${valB}</span>
                </div>`;
            };

            const scoreLabel    = T ? 'Score'       : 'Очки';
            const rankLabel     = T ? 'Rank'        : 'Ранк';
            const compLabel     = T ? 'Completions' : 'Прохождений';
            const recLabel      = T ? 'Records'     : 'Рекордов';
            const hardestLabel  = T ? 'Hardest'     : 'Хардест';

            document.getElementById('compareResult').innerHTML = `
            <div class="compare-grid">
                <div class="compare-col ${winnerA ? 'winner' : ''}">
                    <div class="compare-col-name">
                        ${winnerA ? '<i class="fas fa-crown compare-crown"></i>' : ''}
                        ${escapeHtml(nameA)}
                    </div>
                    ${row(scoreLabel, a.pts.toFixed(1), b.pts)}
                    ${row(rankLabel, a.rank > 0 ? '#'+a.rank : '—', b.rank > 0 ? '#'+b.rank : '—', false)}
                    ${row(compLabel, a.completions, b.completions)}
                    ${row(recLabel, a.records, b.records)}
                    <div class="compare-hardest">
                        <div class="compare-hardest-label">${hardestLabel}</div>
                        <div class="compare-hardest-name">${a.hardest ? escapeHtml(a.hardest.name) : '—'}</div>
                    </div>
                </div>
                <div class="compare-col ${!winnerA ? 'winner' : ''}">
                    <div class="compare-col-name">
                        ${!winnerA ? '<i class="fas fa-crown compare-crown"></i>' : ''}
                        ${escapeHtml(nameB)}
                    </div>
                    ${rowB(scoreLabel, a.pts.toFixed(1), b.pts.toFixed(1))}
                    ${rowB(rankLabel, a.rank > 0 ? '#'+a.rank : '—', b.rank > 0 ? '#'+b.rank : '—', false)}
                    ${rowB(compLabel, a.completions, b.completions)}
                    ${rowB(recLabel, a.records, b.records)}
                    <div class="compare-hardest">
                        <div class="compare-hardest-label">${hardestLabel}</div>
                        <div class="compare-hardest-name">${b.hardest ? escapeHtml(b.hardest.name) : '—'}</div>
                    </div>
                </div>
            </div>`;
        }

        function updateHomeOverview() {
            const setText = (id, value) => {
                const el = document.getElementById(id);
                if (el) el.textContent = value;
            };

            setText('homeStatDemons', demons.length);
            setText('homeStatChallenges', challenges.length);
            setText('homeStatCreators', creators.length);

            const players = new Set();
            const collect = (level) => getLevelEntries(level).forEach(v => {
                const name = (v.name || '').trim().toLowerCase();
                if (name) players.add(name);
            });
            demons.forEach(collect);
            challenges.forEach(collect);
            setText('homeStatPlayers', players.size);
        }

        function loadStats() {
            // Подсчёт демонов и челленджей уже в памяти
            const T = currentLang === 'EN';
            document.getElementById('statTotalDemons').textContent      = demons.length;
            document.getElementById('statTotalChallenges').textContent  = challenges.length;
            document.getElementById('statHardestDemon').textContent     = demons[0]     ? fixStr(demons[0].name)     : '—';
            document.getElementById('statHardestChallenge').textContent = challenges[0] ? fixStr(challenges[0].name) : '—';
            document.getElementById('statsUpdatedAt').textContent = (T ? 'Updated: ' : 'Обновлено: ') + new Date().toLocaleDateString(T ? 'en-GB' : 'ru-RU', { day:'2-digit', month:'long', year:'numeric' });

            // Топ слеер и число игроков — считаем из рекордов уровней (как во вкладке "Топ Слееров")
            const slayerMap = {};
            const collectSlayers = (level) => getLevelEntries(level).forEach(v => {
                const name = v.name ? v.name.trim() : '';
                if (!name) return;
                if (!(name in slayerMap)) slayerMap[name] = 0;
                const perc = parseInt((v.perc || '0').replace('%', ''));
                if (perc >= MIN_PERC) slayerMap[name] += calcPts(perc, level.points);
            });
            demons.forEach(collectSlayers);
            challenges.forEach(collectSlayers);

            const slayerSorted = Object.entries(slayerMap).sort((a, b) => b[1] - a[1]);
            document.getElementById('statTotalPlayers').textContent = slayerSorted.length;
            const slayerEl = document.getElementById('statTopSlayer');
            const slayerPtsEl = document.getElementById('statTopSlayerPts');
            if (slayerSorted[0]) {
                slayerEl.textContent = fixStr(slayerSorted[0][0]);
                slayerEl.style.color = '#fbbf24';
                const pts = slayerSorted[0][1] < 0.01 ? '0' : slayerSorted[0][1].toFixed(2);
                slayerPtsEl.textContent = pts + (T ? ' pts' : ' очков');
            } else {
                slayerEl.textContent = '—';
                slayerPtsEl.textContent = '';
            }

            db.ref('creators').once('value', snap => {
                const val = snap.val();
                if (!val) return;
                const list = Object.values(val);
                document.getElementById('statTotalCreators').textContent = list.length;
                const top = list.filter(c => c.points).sort((a,b) => (b.points||0)-(a.points||0));
                if (top[0]) {
                    document.getElementById('statTopCreator').textContent    = fixStr(top[0].name || top[0].nick || '—');
                    document.getElementById('statTopCreatorPts').textContent = top[0].points + (T ? ' pts' : ' очков');
                }
            });

            // Подсчёт всех рекордов
            let totalRecords = 0;
            const countRecords = (ref) => db.ref(ref).once('value', snap => {
                const val = snap.val();
                if (!val) return;
                Object.values(val).forEach(lvl => {
                    if (lvl.victors) totalRecords += Object.keys(lvl.victors).length;
                });
                document.getElementById('statTotalRecords').textContent = totalRecords;
            });
            countRecords('demons');
            countRecords('challenges');

            // Недавние изменения — рендерится живой лентой (обновляется с момента загрузки)
            renderRecentChanges();
        }

        function fixStr(str) {
            if (!str || typeof str !== 'string') return str || '';
            try {
                // Проверяем есть ли типичные артефакты Latin1-декодирования кириллицы
                if (/[\xC0-\xFF][\x80-\xBF]/.test(str)) {
                    return decodeURIComponent(escape(str));
                }
            } catch(e) {}
            return str;
        }

        // Сравнивает новый порядок списка с предыдущим и записывает недавние изменения.
        // Первый вызов только запоминает состояние (изменения считаем с момента загрузки).
        function detectListChanges(type, newList) {
            const prev = _prevOrder[type];
            const nextMap = {};
            newList.forEach((it, idx) => { nextMap[it.key] = { pos: idx, name: it.name }; });

            if (prev) {
                const adds = newList.filter(it => !(it.key in prev));
                adds.forEach((a, i) => {
                    const idx = newList.findIndex(x => x.key === a.key);
                    pushChange({ kind: 'add', type, key: a.key, name: a.name, pos: idx + 1, ts: Date.now() });
                });
                // Перестановки записываем только если не было добавлений (иначе это сдвиг из-за вставки)
                if (adds.length === 0) {
                    const moves = [];
                    newList.forEach((it, idx) => {
                        if ((it.key in prev) && prev[it.key].pos !== idx) {
                            moves.push({ key: it.key, name: it.name, from: prev[it.key].pos, to: idx });
                        }
                    });
                    if (moves.length) {
                        // Берём тот уровень, который поднялся выше всех (самый значимый переезд)
                        moves.sort((a, b) => (a.to - a.from) - (b.to - b.from));
                        const m = moves[0];
                        pushChange({ kind: 'move', type, key: m.key, name: m.name, from: m.from + 1, to: m.to + 1, ts: Date.now() });
                    }
                }
            }
            _prevOrder[type] = nextMap;
        }

        function pushChange(ev) {
            // Защита от дубля одного и того же события подряд
            const last = recentChanges[0];
            if (last && last.kind === ev.kind && last.key === ev.key && last.to === ev.to && last.pos === ev.pos && (ev.ts - last.ts) < 1500) return;
            recentChanges.unshift(ev);
            if (recentChanges.length > RECENT_MAX) recentChanges.length = RECENT_MAX;
            renderRecentChanges();
        }

        function renderRecentChanges() {
            const el = document.getElementById('statRecentlyAdded');
            if (!el) return;
            const T = currentLang === 'EN';
            const openArgs = (ev) => {
                const tab = ev.type === 'challenge' || ev.type === 'challenges' ? 'challenges' : 'demons';
                return `openSection('listSection');switchTab('${tab}');setTimeout(()=>showInfoByKey('${ev.key}','${tab}'),200);`;
            };
            const typeBadge = (ev) => {
                const isChal = ev.type === 'challenge' || ev.type === 'challenges';
                return `<span class="stat-recent-type ${isChal ? 'challenge' : 'demon'}">${isChal ? (T ? 'Challenge' : 'Челлендж') : (T ? 'Demon' : 'Демон')}</span>`;
            };

            if (recentChanges.length) {
                el.innerHTML = recentChanges.map(ev => {
                    const time = new Date(ev.ts).toLocaleTimeString(T ? 'en-US' : 'ru-RU', { hour: '2-digit', minute: '2-digit' });
                    let action;
                    if (ev.kind === 'add') {
                        action = `<span style="color:#34d399;font-size:0.7rem;font-weight:800;flex-shrink:0;"><i class="fas fa-plus"></i> ${T ? 'added' : 'добавлен'} #${ev.pos}</span>`;
                    } else {
                        const up = ev.to < ev.from;
                        action = `<span style="color:${up ? '#34d399' : '#f472b6'};font-size:0.7rem;font-weight:800;flex-shrink:0;"><i class="fas fa-arrow-${up ? 'up' : 'down'}"></i> #${ev.from}&rarr;#${ev.to}</span>`;
                    }
                    return `<div class="stat-recent-item" onclick="${openArgs(ev)}">
                        ${typeBadge(ev)}
                        <span style="color:#e2e8f0;font-size:0.85rem;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ev.name)}</span>
                        ${action}
                        <span style="color:#4b5563;font-size:0.7rem;flex-shrink:0;">${time}</span>
                    </div>`;
                }).join('');
                return;
            }

            // Фолбэк: пока изменений с загрузки не было — показываем недавно добавленные по дате
            const allLevels = [
                ...demons.map(d => ({ ...d, type: 'demon' })),
                ...challenges.map(c => ({ ...c, type: 'challenge' }))
            ].filter(l => l.addedAt).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 6);

            if (allLevels.length === 0) {
                el.innerHTML = `<p style="color:#4b5563;font-size:0.82rem;">${T ? 'No changes since page load' : 'Пока нет изменений с момента загрузки'}</p>`;
                return;
            }
            el.innerHTML = allLevels.map(l => {
                const ownList = l.type === 'challenge' ? challenges : demons;
                const pos = ownList.findIndex(x => x.key === l.key) + 1;
                const date = l.addedAt ? new Date(l.addedAt).toLocaleDateString(T ? 'en-US' : 'ru-RU', { day: '2-digit', month: 'short' }) : '';
                return `<div class="stat-recent-item" onclick="openSection('listSection');switchTab('${l.type === 'challenge' ? 'challenges' : 'demons'}');setTimeout(()=>showInfoByKey('${l.key}','${l.type === 'challenge' ? 'challenges' : 'demons'}'),200);">
                    <span class="stat-recent-type ${l.type}">${l.type === 'challenge' ? (T ? 'Challenge' : 'Челлендж') : (T ? 'Demon' : 'Демон')}</span>
                    <span style="color:#94a3b8;font-family:'Orbitron';font-size:0.65rem;font-weight:700;flex-shrink:0;">#${pos}</span>
                    <span style="color:#e2e8f0;font-size:0.85rem;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(l.name)}</span>
                    <span style="color:#4b5563;font-size:0.72rem;flex-shrink:0;">${date}</span>
                </div>`;
            }).join('');
        }

        function renderStarsHtml(rating) {
            let html = '';
            for (let i = 1; i <= 5; i++) {
                html += `<i class="fas fa-star${i <= rating ? '' : ' empty'}"></i>`;
            }
            return html;
        }

        function renderApprovedReviews() {
            const grid = document.getElementById('reviewsGrid');
            if (!grid) return;
            const approved = reviews.filter(r => r.status === 'approved');
            if (approved.length === 0) {
                grid.innerHTML = '<div class="reviews-empty">Пока нет отзывов. Будь первым!</div>';
                return;
            }
            grid.innerHTML = approved.map(r => `
                <div class="review-card">
                    <div class="review-card-head">
                        <span class="review-card-name">${escapeHtml(r.name)}</span>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span class="review-card-stars">${renderStarsHtml(r.rating || 0)}</span>
                            ${(isAdmin || currentUserPermissions.canDeleteReviews) ? `<button onclick="deleteReview('${r.key}')" title="Удалить отзыв" style="background:rgba(255,70,70,0.12);border:1px solid rgba(255,70,70,0.3);color:#ff6868;border-radius:7px;width:26px;height:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.75rem;flex-shrink:0;transition:0.2s;" onmouseover="this.style.background='rgba(255,70,70,0.25)'" onmouseout="this.style.background='rgba(255,70,70,0.12)'"><i class="fas fa-trash"></i></button>` : ''}
                        </div>
                    </div>
                    <p class="review-card-text">${escapeHtml(r.text)}</p>
                </div>
            `).join('');
        }

        function deleteReview(key) {
            if (!isAdmin && !currentUserPermissions.canDeleteReviews) return;
            if (!confirm('Удалить этот отзыв?')) return;
            db.ref('reviews/' + key).remove()
                .then(() => showToast('🗑️ Отзыв удалён'))
                .catch(e => showToast('Ошибка: ' + e.message));
        }

        function renderModReviews() {
            const list = document.getElementById('modReviewsList');
            const countEl = document.getElementById('modReviewCount');
            if (!list) return;
            const pending = reviews.filter(r => r.status === 'pending');
            if (countEl) countEl.textContent = pending.length ? `(${pending.length})` : '';
            if (pending.length === 0) {
                list.innerHTML = '<p style="color:#555;text-align:center;font-size:0.82rem;margin:6px 0;">Нет отзывов на проверке</p>';
                return;
            }
            list.innerHTML = pending.map(r => `
                <div style="background:rgba(4,5,13,0.6);border:1px solid rgba(167,139,250,0.12);border-radius:12px;padding:12px;margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                        <strong style="font-size:0.85rem;color:#fff;">${escapeHtml(r.name)}</strong>
                        <span style="color:#fbbf24;font-size:0.75rem;">${renderStarsHtml(r.rating || 0)}</span>
                    </div>
                    <p style="font-size:0.8rem;color:var(--text-main);margin:0 0 10px;word-break:break-word;">${escapeHtml(r.text)}</p>
                    <div style="display:flex;gap:8px;">
                        <button onclick="approveReview('${r.key}')" style="flex:1;padding:8px;background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.3);color:#4ade80;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.78rem;font-family:Nunito;text-transform:uppercase;">
                            <i class="fas fa-check"></i> Одобрить
                        </button>
                        <button onclick="rejectReview('${r.key}')" style="flex:1;padding:8px;background:rgba(255,70,70,0.1);border:1px solid rgba(255,70,70,0.3);color:#ff6868;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.78rem;font-family:Nunito;text-transform:uppercase;">
                            <i class="fas fa-times"></i> Отклонить
                        </button>
                    </div>
                </div>
            `).join('');
        }

        function approveReview(key) {
            if (!isModerator) return;
            db.ref('reviews/' + key).update({ status: 'approved' }).then(() => showToast('✅ Отзыв опубликован!')).catch(e => showToast('Ошибка: ' + e.message));
        }

        function rejectReview(key) {
            if (!isModerator) return;
            if (!confirm('Удалить этот отзыв?')) return;
            db.ref('reviews/' + key).remove().then(() => showToast('🗑️ Отзыв отклонён')).catch(e => showToast('Ошибка: ' + e.message));
        }

        // Captcha stored in closure — NOT accessible from window/global scope
        const _captcha = (() => {
            let _answer = 0;
            return {
                generate() {
                    const a = Math.floor(Math.random() * 9) + 2;
                    const b = Math.floor(Math.random() * 9) + 2;
                    const op = Math.random() < 0.5 ? '+' : (a >= b ? '-' : '+');
                    _answer = op === '+' ? a + b : a - b;
                    const qEl = document.getElementById('captchaQuestion');
                    if (qEl) qEl.textContent = `${a} ${op === '+' ? '+' : '−'} ${b === _answer - a ? b : b}`;
                    // Rewrite display cleanly
                    if (qEl) qEl.textContent = op === '+' ? `${a} + ${b}` : `${a} − ${b}`;
                    const aEl = document.getElementById('captchaAnswer');
                    if (aEl) aEl.value = '';
                },
                verify(val) { return parseInt(val) === _answer; },
                reset() { _answer = 0; }
            };
        })();

        function generateReviewCaptcha() { _captcha.generate(); }

        document.addEventListener('DOMContentLoaded', () => {
            const picker = document.getElementById('reviewStarsPicker');
            if (!picker) return;
            const stars = picker.querySelectorAll('i');
            stars.forEach(star => {
                star.addEventListener('click', () => {
                    selectedReviewRating = parseInt(star.dataset.val);
                    stars.forEach(s => s.classList.toggle('active', parseInt(s.dataset.val) <= selectedReviewRating));
                });
            });
            // Migrate old key if present
            try {
                const oldVal = localStorage.getItem('lastReviewAt');
                if (oldVal) { localStorage.setItem(REVIEW_LOCAL_KEY, oldVal); localStorage.removeItem('lastReviewAt'); }
            } catch(e) {}
            updateReviewFormCooldownUI();
            generateReviewCaptcha();
        });

        function updateReviewFormCooldownUI() {
            const note = document.querySelector('.review-submit-note');
            const btn = document.querySelector('.review-submit-btn');
            if (!note || !btn) return;
            const cooldownLeft = getReviewCooldownLeft();
            const T = currentLang === 'EN';
            if (cooldownLeft > 0) {
                const hours = Math.ceil(cooldownLeft / (60 * 60 * 1000));
                note.textContent = T
                    ? `You already left a review. You can write a new one in ~${hours}h.`
                    : `Ты уже оставлял отзыв. Можно будет написать новый через ~${hours} ч.`;
                btn.disabled = true;
                btn.style.opacity = '0.5';
                btn.style.cursor = 'not-allowed';
            } else {
                note.textContent = T
                    ? 'Your review will appear on the site after moderator approval'
                    : 'Отзыв появится на сайте после проверки модератором';
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.style.cursor = 'pointer';
            }
        }

        const REVIEW_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
        const REVIEW_SESSION_KEY = 'rv_s';   // session marker (cleared on tab close)
        const REVIEW_LOCAL_KEY  = 'rv_l';    // persistent marker

        function _setReviewSent() {
            const t = Date.now().toString();
            try { sessionStorage.setItem(REVIEW_SESSION_KEY, t); } catch(e){}
            try { localStorage.setItem(REVIEW_LOCAL_KEY, t); } catch(e){}
        }

        function getReviewCooldownLeft() {
            let last = 0;
            try { last = Math.max(last, parseInt(sessionStorage.getItem(REVIEW_SESSION_KEY) || '0')); } catch(e){}
            try { last = Math.max(last, parseInt(localStorage.getItem(REVIEW_LOCAL_KEY) || '0')); } catch(e){}
            const left = REVIEW_COOLDOWN_MS - (Date.now() - last);
            return left > 0 ? left : 0;
        }

        // In-memory submit lock — cannot be bypassed from console
        let _reviewSubmitting = false;

        function submitReview() {
            // 1. In-flight lock
            if (_reviewSubmitting) return;

            // 2. Client-side cooldown (both storages)
            const cooldownLeft = getReviewCooldownLeft();
            if (cooldownLeft > 0) {
                const hours = Math.ceil(cooldownLeft / (60 * 60 * 1000));
                showToast(`Ты уже оставлял отзыв. Попробуй через ~${hours} ч.`);
                return;
            }

            // 3. Field validation — enforce lengths server-side too (slice before push)
            const name = document.getElementById('reviewName').value.trim().slice(0, 30);
            const text = document.getElementById('reviewText').value.trim().slice(0, 400);

            if (!name || name.length < 2)  { showToast('Введи ник (минимум 2 символа)!'); return; }
            if (!text || text.length < 10) { showToast('Напиши отзыв (минимум 10 символов)!'); return; }
            if (!selectedReviewRating || selectedReviewRating < 1 || selectedReviewRating > 5) {
                showToast('Поставь оценку звёздами!'); return;
            }

            // 4. Captcha check via closure — not readable from window
            const captchaVal = (document.getElementById('captchaAnswer').value || '').trim();
            if (!_captcha.verify(captchaVal)) {
                showToast('Неверный ответ на пример. Попробуй ещё раз!');
                _captcha.generate();
                return;
            }

            // 5. Basic content sanity — no pure-whitespace or repeated chars
            if (/^(.)\1{4,}$/.test(name) || /^(.)\1{9,}$/.test(text)) {
                showToast('Пожалуйста, введи нормальный текст!');
                return;
            }

            // 6. Server-side duplicate check — same name + same text pending/approved
            const dupExists = reviews.some(r =>
                r.name.toLowerCase() === name.toLowerCase() &&
                r.text.toLowerCase() === text.toLowerCase()
            );
            if (dupExists) {
                showToast('Такой отзыв уже существует!');
                return;
            }

            _reviewSubmitting = true;
            const submitBtn = document.querySelector('.review-submit-btn');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.5'; }

            // 7. Write to Firebase — createdAt uses firebase.database.ServerValue.TIMESTAMP
            //    so client cannot fake the time
            const reviewPushPromise = db.ref('reviews').push({
                name,
                text,
                rating: selectedReviewRating,
                status: 'pending',
                createdAt: firebase.database.ServerValue.TIMESTAMP
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Превышено время ожидания. Проверь соединение.')), 12000)
            );

            Promise.race([reviewPushPromise, timeoutPromise]).then(() => {
                _setReviewSent();
                showToast('Отзыв отправлен на проверку!');
                document.getElementById('reviewName').value = '';
                document.getElementById('reviewText').value = '';
                selectedReviewRating = 0;
                document.querySelectorAll('#reviewStarsPicker i').forEach(s => s.classList.remove('active'));
                _captcha.generate();
                updateReviewFormCooldownUI();
            }).catch(e => {
                showToast('Ошибка: ' + e.message);
                _captcha.generate();
            }).finally(() => {
                _reviewSubmitting = false;
                if (submitBtn) {
                    const disabled = getReviewCooldownLeft() > 0;
                    submitBtn.disabled = disabled;
                    submitBtn.style.opacity = disabled ? '0.5' : '1';
                }
            });
        }

        function renderModList() {
            const container = document.getElementById('modListContainer');
            if (!container) return;
            if (moderators.length === 0) {
                container.innerHTML = '<p style="color:#555;text-align:center;font-size:0.85rem;">Модераторов пока нет</p>';
                return;
            }
            container.innerHTML = moderators.map(m => {
                const p = m.permissions || {};
                const isModRole = m.role !== 'admin';
                const permBadges = isModRole ? `
                    <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:7px;">
                        <span class="perm-badge ${p.canAddDemons ? 'on' : 'off'}"><i class="fas fa-skull-crossbones"></i> Демоны</span>
                        <span class="perm-badge ${p.canAddChallenges ? 'on' : 'off'}"><i class="fas fa-bolt"></i> Челленджи</span>
                        <span class="perm-badge ${p.canAddRecords ? 'on' : 'off'}"><i class="fas fa-medal"></i> Рекорды</span>
                        <span class="perm-badge ${p.canDeleteReviews ? 'on' : 'off'}"><i class="fas fa-trash-alt"></i> Отзывы</span>
                    </div>` : '<div style="margin-top:6px;font-size:0.72rem;color:#666;">Полный доступ ко всем функциям</div>';
                return `
                <div style="background:rgba(4,5,13,0.6);border:1px solid rgba(167,139,250,0.1);border-radius:12px;padding:12px 14px;margin-bottom:8px;">
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:0.78rem;color:#555;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${m.email || '—'}</div>
                            <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;">
                                <span style="font-weight:700;color:#e2d4f0;font-size:0.88rem;">${m.nick || 'Без ника'}</span>
                                <span style="display:inline-block;padding:2px 8px;border-radius:5px;font-size:0.62rem;font-weight:900;letter-spacing:0.5px;text-transform:uppercase;${m.role === 'admin' ? 'background:rgba(244,114,182,0.12);border:1px solid rgba(244,114,182,0.3);color:#f472b6;' : 'background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.25);color:#60a5fa;'}">
                                    ${m.role === 'admin' ? 'Админ' : 'Мод'}
                                </span>
                            </div>
                            ${permBadges}
                        </div>
                        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
                            ${isModRole ? `<button class="mod-perm-btn" onclick="openEditPermModal('${m.uid}')" title="Редактировать права"><i class="fas fa-key"></i></button>` : ''}
                            <button style="width:30px;height:30px;border-radius:7px;background:rgba(255,70,70,0.1);border:1px solid rgba(255,70,70,0.25);color:#ff6868;font-size:0.8rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:0.2s;" onmouseover="this.style.background='rgba(255,70,70,0.22)'" onmouseout="this.style.background='rgba(255,70,70,0.1)'" onclick="removeModerator('${m.uid}', '${m.email || ''}')">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        function openEditPermModal(uid) {
            const m = moderators.find(x => x.uid === uid);
            if (!m) return;
            const p = m.permissions || {};
            document.getElementById('editPermUid').value = uid;
            document.getElementById('editPermNick').textContent = (m.nick || m.email || uid);
            document.getElementById('editPermAddDemons').checked    = !!p.canAddDemons;
            document.getElementById('editPermAddChallenges').checked = !!p.canAddChallenges;
            document.getElementById('editPermAddRecords').checked   = !!p.canAddRecords;
            document.getElementById('editPermDeleteReviews').checked = !!p.canDeleteReviews;
            document.getElementById('editPermModal').style.display  = 'flex';
        }

        async function saveModPermissions() {
            if (!isAdmin) return;
            const uid = document.getElementById('editPermUid').value;
            const permissions = {
                canAddDemons:    document.getElementById('editPermAddDemons').checked,
                canAddChallenges: document.getElementById('editPermAddChallenges').checked,
                canAddRecords:   document.getElementById('editPermAddRecords').checked,
                canDeleteReviews: document.getElementById('editPermDeleteReviews').checked
            };
            try {
                await db.ref('moderators/' + uid + '/permissions').set(permissions);
                // Обновить локально если это текущий пользователь
                if (auth.currentUser && auth.currentUser.uid === uid) {
                    currentUserPermissions = permissions;
                }
                showToast('✅ Права обновлены!');
                document.getElementById('editPermModal').style.display = 'none';
            } catch(e) {
                showToast('Ошибка: ' + e.message);
            }
        }

        function openModPanel() {
            if (!isAdmin) return;
            document.getElementById('modPanel').style.display = 'block';
            renderModList();
        }
        function closeModPanel() {
            document.getElementById('modPanel').style.display = 'none';
        }

        // Переключение между "создать новый" и "выдать существующему (по UID)"
        function toggleModAddMode() {
            const mode = document.getElementById('newModMode').value;
            const existing = mode === 'existing';
            document.getElementById('newModPass').style.display    = existing ? 'none' : 'block';
            document.getElementById('newModUid').style.display     = existing ? 'block' : 'none';
            document.getElementById('newModUidHint').style.display = existing ? 'block' : 'none';
            const btn = document.getElementById('modAddBtn');
            btn.innerHTML = existing
                ? '<i class="fas fa-user-shield"></i> Выдать права аккаунту'
                : '<i class="fas fa-user-plus"></i> Создать аккаунт модератора';
        }

        async function addModerator() {
            if (!isAdmin) return;
            const mode  = document.getElementById('newModMode').value;
            const email = document.getElementById('newModEmail').value.trim();
            const pass  = document.getElementById('newModPass').value;
            const uid   = document.getElementById('newModUid').value.trim();
            const nick  = document.getElementById('newModNick').value.trim();
            const role  = document.getElementById('newModRole').value;

            // Собираем разрешения (только для роли moderator; admin получает всё)
            const permissions = role === 'moderator' ? {
                canAddDemons:     document.getElementById('permAddDemons').checked,
                canAddChallenges: document.getElementById('permAddChallenges').checked,
                canAddRecords:    document.getElementById('permAddRecords').checked,
                canDeleteReviews: document.getElementById('permDeleteReviews').checked
            } : {
                canAddDemons: true, canAddChallenges: true,
                canAddRecords: true, canDeleteReviews: true
            };

            const resetForm = () => {
                document.getElementById('newModEmail').value = '';
                document.getElementById('newModPass').value = '';
                document.getElementById('newModUid').value = '';
                document.getElementById('newModNick').value = '';
                document.getElementById('permAddDemons').checked = true;
                document.getElementById('permAddChallenges').checked = true;
                document.getElementById('permAddRecords').checked = true;
                document.getElementById('permDeleteReviews').checked = false;
            };

            // === Режим 2: выдать права уже существующему аккаунту по UID ===
            if (mode === 'existing') {
                if (!uid) { showToast('Вставь Firebase UID аккаунта'); return; }
                try {
                    const existingSnap = await db.ref('moderators/' + uid).once('value');
                    if (existingSnap.exists()) { showToast('У этого аккаунта уже есть права'); return; }
                    await db.ref('moderators/' + uid).set({ email: email || '', nick, role, permissions, createdAt: Date.now() });
                    showToast('✅ Права выданы! Пусть человек перезайдёт на сайт.');
                    resetForm();
                } catch (e) {
                    console.error(e);
                    showToast('Ошибка: ' + (e.message || 'неизвестная ошибка'));
                }
                return;
            }

            // === Режим 1: создать новый аккаунт ===
            if (!email || !pass || pass.length < 6) {
                showToast('Заполни email и пароль (мин. 6 символов)');
                return;
            }
            try {
                const secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary_' + Date.now());
                const secondaryAuth = secondaryApp.auth();
                const cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
                const newUid = cred.user.uid;
                await secondaryAuth.signOut();
                secondaryApp.delete();

                await db.ref('moderators/' + newUid).set({ email, nick, role, permissions, createdAt: Date.now() });
                showToast('Модератор успешно добавлен!');
                resetForm();
            } catch (e) {
                console.error(e);
                if (e.code === 'auth/email-already-in-use') {
                    showToast('Этот email уже занят. Выбери режим «Выдать права существующему (по UID)».');
                } else {
                    showToast('Ошибка: ' + (e.message || 'неизвестная ошибка'));
                }
            }
        }

        async function removeModerator(uid, email) {
            if (!isAdmin) return;
            if (!confirm(`Удалить модератора ${email}?\n\nАккаунт Firebase останется, но права будут убраны.`)) return;
            await db.ref('moderators/' + uid).remove();
            showToast('Права модератора убраны');
        }

        // ===== ADMIN AUTH =====
        function adminLogin() {
            const email = document.getElementById('adminEmail').value.trim();
            const pass = document.getElementById('adminPass').value;
            const errEl = document.getElementById('loginError');
            errEl.style.display = 'none';
            auth.signInWithEmailAndPassword(email, pass)
                .then(() => {
                    document.getElementById('loginBlock').style.display = 'none';
                    document.getElementById('adminControls').style.display = 'block';
                    toggleAdmFields();
                })
                .catch(() => { errEl.style.display = 'block'; });
        }
        function adminLogout() { auth.signOut(); closeAdmin(); }

        function openAdmin() {
            document.getElementById('loginBlock').style.display = isModerator ? 'none' : 'block';
            document.getElementById('adminControls').style.display = isModerator ? 'block' : 'none';
            document.getElementById('loginError').style.display = 'none';
            document.getElementById('adminPanel').style.display = 'block';
            const sel = document.getElementById('admAction');
            if (sel) {
                const canReorder = isAdmin || currentUserPermissions.canAddDemons || currentUserPermissions.canAddChallenges;
                Array.from(sel.options).forEach(opt => {
                    // Действия только для админа
                    if (['delete_all_demons','manage_mods','maintenance','delete_mode','clear_history','add_creator'].includes(opt.value)) {
                        opt.disabled = !isAdmin;
                        opt.style.color = isAdmin ? '' : '#555';
                    }
                    // Drag & Drop — админ или модератор с правом на демонов/челленджи
                    if (opt.value === 'drag_drop') {
                        opt.disabled = !canReorder;
                        opt.style.color = canReorder ? '' : '#555';
                    }
                    // Добавление демонов/челленджей — по гранулярным правам
                    if (opt.value === 'add_demon') {
                        const ok = isAdmin || currentUserPermissions.canAddDemons;
                        opt.disabled = !ok; opt.style.color = ok ? '' : '#555';
                    }
                    if (opt.value === 'add_challenge') {
                        const ok = isAdmin || currentUserPermissions.canAddChallenges;
                        opt.disabled = !ok; opt.style.color = ok ? '' : '#555';
                    }
                });
            }
            toggleAdmFields();
        }

        // ===== EDIT DEMON/CHALLENGE =====
        function openEditModal(key, type = 'demons') {
            if (!isModerator) return;
            
            const list = type === 'demons' ? demons : challenges;
            const d = list.find(x => x.key === key);
            if (!d) return;

            document.getElementById('editItemType').value = type;
            document.getElementById('editDemonKey').value = key;
            document.getElementById('editName').value = d.name || '';
            document.getElementById('editAuthor').value = d.author || '';
            document.getElementById('editVerifier').value = d.verifier || '';
            document.getElementById('editLevelID').value = d.levelID || '';
            document.getElementById('editTag').value = d.tag || '';
            document.getElementById('editImg').value = d.img || '';
            document.getElementById('editVid').value = d.vid ? `https://youtube.com/watch?v=${d.vid}` : '';
            document.getElementById('editPoints').value = d.points || '';
            document.getElementById('editStatus').value = d.status || '';
            updateImgPreview();
            
            document.getElementById('editDemonModal').style.display = 'block';
            document.getElementById('editDemonModal').scrollTop = 0;
        }

        function closeEditModal() {
            document.getElementById('editDemonModal').style.display = 'none';
        }

        function updateImgPreview() {
            const url = document.getElementById('editImg').value.trim();
            const preview = document.getElementById('editImgPreview');
            if (url) {
                preview.src = url;
                preview.style.display = 'block';
                preview.onerror = () => { preview.style.display = 'none'; };
            } else {
                preview.style.display = 'none';
            }
        }

        function saveDemonEdit() {
            const type = document.getElementById('editItemType').value;
            const key = document.getElementById('editDemonKey').value;
            const name = document.getElementById('editName').value.trim();
            const author = document.getElementById('editAuthor').value.trim();
            const verifier = document.getElementById('editVerifier').value.trim();
            const levelID = document.getElementById('editLevelID').value.trim();
            const tag = document.getElementById('editTag').value.trim();
            const img = document.getElementById('editImg').value.trim();
            let vidRaw = document.getElementById('editVid').value.trim();

            if (!name) { showToast('Введи название уровня'); return; }

            let vid = vidRaw;
            if (vidRaw.includes('v=')) vid = vidRaw.split('v=')[1].split('&')[0];
            else if (vidRaw.includes('youtu.be/')) vid = vidRaw.split('youtu.be/')[1].split('?')[0];

            const points = document.getElementById('editPoints').value.trim();
            const status = document.getElementById('editStatus').value;
            const updates = { name, author, verifier, levelID, tag, img, vid, points, status };
            
            db.ref(`${type}/` + key).update(updates).then(() => {
                showToast('Успешно обновлено!');
                closeEditModal();
            }).catch(e => { showToast('Ошибка: ' + e.message); });
        }

        // ===== EDIT CREATOR =====
        function openEditCreatorModal(key) {
            if (!isAdmin) return;
            const c = creators.find(x => x.key === key);
            if (!c) return;
            document.getElementById('editCreatorKey').value = key;
            document.getElementById('editCreatorName').value = c.name || '';
            document.getElementById('editCreatorPoints').value = c.points || 0;
            document.getElementById('editCreatorModal').style.display = 'block';
        }

        function saveCreatorEdit() {
            if (!isAdmin) return;
            const key = document.getElementById('editCreatorKey').value;
            const name = document.getElementById('editCreatorName').value.trim();
            const points = parseInt(document.getElementById('editCreatorPoints').value) || 0;
            
            if (!name) return showToast('Введи имя!');
            
            db.ref('creators/' + key).update({ name, points }).then(() => {
                showToast('Создатель обновлен!');
                document.getElementById('editCreatorModal').style.display = 'none';
            }).catch(e => showToast('Ошибка: ' + e.message));
        }

        // ===== EDIT SLAYER =====
        function openEditSlayerModal(oldName) {
            if (!isAdmin) return;
            document.getElementById('editSlayerOldName').value = oldName;
            document.getElementById('editSlayerNewName').value = oldName;
            document.getElementById('editSlayerModal').style.display = 'block';
        }

        function saveSlayerEdit() {
            if (!isAdmin) return;
            const oldName = document.getElementById('editSlayerOldName').value;
            const newName = document.getElementById('editSlayerNewName').value.trim();
            if (!newName || oldName === newName) {
                document.getElementById('editSlayerModal').style.display = 'none';
                return;
            }

            let updates = {};
            // Обновляем в демонах
            demons.forEach(d => {
                if(d.victors) {
                    Object.entries(d.victors).forEach(([vk, v]) => {
                        if(v.name === oldName) { updates[`demons/${d.key}/victors/${vk}/name`] = newName; }
                    });
                }
            });
            // Обновляем в челленджах
            challenges.forEach(c => {
                if(c.victors) {
                    Object.entries(c.victors).forEach(([vk, v]) => {
                        if(v.name === oldName) { updates[`challenges/${c.key}/victors/${vk}/name`] = newName; }
                    });
                }
            });
            
            if (Object.keys(updates).length > 0) {
                db.ref().update(updates).then(() => {
                    showToast('Ник слеера обновлен во всех рекордах!');
                    document.getElementById('editSlayerModal').style.display = 'none';
                }).catch(e => showToast('Ошибка: ' + e.message));
            } else {
                document.getElementById('editSlayerModal').style.display = 'none';
            }
        }

        function deleteSlayer(name) {
            if (!isAdmin || !confirm(`Удалить все рекорды слеера ${name}? Это действие нельзя отменить!`)) return;
            
            let updates = {};
            demons.forEach(d => {
                if(d.victors) {
                    Object.entries(d.victors).forEach(([vk, v]) => {
                        if(v.name === name) { updates[`demons/${d.key}/victors/${vk}`] = null; }
                    });
                }
            });
            challenges.forEach(c => {
                if(c.victors) {
                    Object.entries(c.victors).forEach(([vk, v]) => {
                        if(v.name === name) { updates[`challenges/${c.key}/victors/${vk}`] = null; }
                    });
                }
            });
            
            db.ref().update(updates).then(() => {
                showToast(`Все рекорды слеера ${name} удалены!`);
            }).catch(e => showToast('Ошибка: ' + e.message));
        }

        // ===== NAVIGATION =====
        function toggleBurger() {
            const menu = document.getElementById('mobileMenu');
            const btn  = document.getElementById('burgerBtn');
            const open = menu.classList.contains('open');
            menu.classList.toggle('open', !open);
            btn.classList.toggle('open', !open);
        }
        function closeBurger() {
            document.getElementById('mobileMenu').classList.remove('open');
            document.getElementById('burgerBtn').classList.remove('open');
        }

        const NAV_SECTION_KEY = 'nightLastSection';
        const NAV_TAB_KEY = 'nightLastListTab';
        const VALID_NAV_SECTIONS = new Set(['homeSection', 'statsSection', 'downloadSection', 'listSection', 'accountSection', 'recordSubmitSection']);
        const VALID_LIST_TABS = new Set(['demons', 'challenges', 'players', 'creatortop', 'playersearch']);

        function openSection(id, remember = true) {
            if (!VALID_NAV_SECTIONS.has(id)) return;
            document.querySelectorAll('.section-page').forEach(sec => sec.classList.remove('active'));
            const target = document.getElementById(id);
            if (!target) return;
            target.classList.add('active');
            if (remember) {
                try { localStorage.setItem(NAV_SECTION_KEY, id); } catch (e) {}
            }
            window.scrollTo(0,0);
            const drops = document.getElementsByClassName("dropdown-content");
            for (let i = 0; i < drops.length; i++) { drops[i].classList.remove('show'); }
            closeBurger();
            if (id === 'statsSection') loadStats();
            if (id === 'accountSection' && window.NightAccounts) window.NightAccounts.renderAccountSection();
            if (id === 'recordSubmitSection' && window.NightAccounts) window.NightAccounts.prepareRecordSubmissionSection();
        }

        function restoreNavigationState() {
            // Прямые hash-ссылки (#demon/..., #challenge/..., #modloginpage) важнее сохранённого раздела.
            if (window.location.hash) return;
            let section = 'homeSection';
            let tab = 'demons';
            try {
                const savedSection = localStorage.getItem(NAV_SECTION_KEY);
                const savedTab = localStorage.getItem(NAV_TAB_KEY);
                if (VALID_NAV_SECTIONS.has(savedSection)) section = savedSection;
                if (VALID_LIST_TABS.has(savedTab)) tab = savedTab;
            } catch (e) {}

            openSection(section, false);
            if (section === 'listSection') switchTab(tab, false);
        }

        function toggleDropdown(id, event) {
            event.stopPropagation();
            document.getElementById(id).classList.toggle("show");
        }

        window.onclick = function(event) {
            if (!event.target.matches('.nav-item') && !event.target.matches('.fa-caret-down')) {
                var dropdowns = document.getElementsByClassName("dropdown-content");
                for (var i = 0; i < dropdowns.length; i++) {
                    if (dropdowns[i].classList.contains('show')) { dropdowns[i].classList.remove('show'); }
                }
            }
        }

        // ===== FIREBASE LISTENERS =====
        db.ref('demons').on('value', s => {
            const val = s.val();
            demons = val ? Object.entries(val).map(([k, d]) => ({ key: k, ...d, name: fixStr(d.name), creator: fixStr(d.creator) })).sort((a,b)=>(a.order||0)-(b.order||0)) : [];
            detectListChanges('demons', demons);
            const sel = document.getElementById('selectDemon');
            if(sel) sel.innerHTML = demons.map(d => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.name)}</option>`).join('');
            populatePositionSelect('itemPosition', 'demons', document.getElementById('admAction')?.value === 'add_demon');
            populatePositionSelect('mPosition', 'demons', document.getElementById('mLevelType')?.value === 'demons');
            updateHomeOverview();
            if (currentTab === 'demons') render();
        });
        
        // Слушатель для челленджей
        db.ref('challenges').on('value', s => {
            const val = s.val();
            challenges = val ? Object.entries(val).map(([k, d]) => ({ key: k, ...d, name: fixStr(d.name), creator: fixStr(d.creator) })).sort((a,b)=>(a.order||0)-(b.order||0)) : [];
            detectListChanges('challenges', challenges);
            const selC = document.getElementById('selectChallenge');
            if (selC) selC.innerHTML = challenges.map(c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.name)}</option>`).join('');
            populatePositionSelect('itemPosition', 'challenges', document.getElementById('admAction')?.value === 'add_challenge');
            populatePositionSelect('mPosition', 'challenges', document.getElementById('mLevelType')?.value === 'challenges');
            updateHomeOverview();
            if (currentTab === 'challenges') render();
        });

        db.ref('creators').on('value', s => {
            const val = s.val();
            creators = val ? Object.entries(val).map(([k, d]) => ({ key: k, ...d })).sort((a,b)=>parseInt(b.points)-parseInt(a.points)) : [];
            updateHomeOverview();
            if (currentTab === 'creatortop') renderCreatorTop();
            else render();
        });

        // ===== SEARCH =====
        // ===== FILTER PANEL =====
        function toggleFilterPanel(event) {
            if (event) event.stopPropagation();
            const panel = document.getElementById('filterPanel');
            const btn = document.getElementById('filterToggleBtn');
            const open = panel.classList.toggle('open');
            btn.classList.toggle('active', open);
            if (open) initFilterRange();
        }

        function initFilterRange() {
            const list = currentTab === 'demons' ? demons : challenges;
            const pts = list.map(d => parseFloat(d.points)).filter(n => !isNaN(n));
            const rMin = document.getElementById('rangeMin');
            const rMax = document.getElementById('rangeMax');
            if (pts.length === 0) return;
            const min = Math.floor(Math.min(...pts));
            const max = Math.ceil(Math.max(...pts));
            filterPtsBounds = { min, max: max > min ? max : min + 1 };
            rMin.min = rMax.min = filterPtsBounds.min;
            rMin.max = rMax.max = filterPtsBounds.max;
            rMin.value = filterState.ptsMin !== null ? filterState.ptsMin : filterPtsBounds.min;
            rMax.value = filterState.ptsMax !== null ? filterState.ptsMax : filterPtsBounds.max;
            updateRangeUI();
        }

        function updateRangeUI() {
            const rMin = document.getElementById('rangeMin');
            const rMax = document.getElementById('rangeMax');
            let lo = parseInt(rMin.value), hi = parseInt(rMax.value);
            if (lo > hi) { const t = lo; lo = hi; hi = t; }
            const { min, max } = filterPtsBounds;
            const span = (max - min) || 1;
            const fill = document.getElementById('rangeFill');
            fill.style.left = ((lo - min) / span * 100) + '%';
            fill.style.right = (100 - (hi - min) / span * 100) + '%';
            document.getElementById('rangeLblMin').textContent = lo;
            document.getElementById('rangeLblMax').innerHTML = hi >= max ? '&infin;' : hi;
            filterState.ptsMin = lo <= min ? null : lo;
            filterState.ptsMax = hi >= max ? null : hi;
        }

        function onRangeInput() { updateRangeUI(); updateFilterBadge(); debouncedRender(); }

        function setStatusFilter(s) {
            filterState.status = s;
            document.querySelectorAll('#filterStatusPills .filter-pill').forEach(p =>
                p.classList.toggle('active', p.dataset.status === s));
            updateFilterBadge();
            render();
        }

        function onFilterChange() {
            filterState.verified = document.getElementById('filterVerified').checked;
            filterState.newOnly = document.getElementById('filterNew').checked;
            updateFilterBadge();
            render();
        }

        function resetFilters() {
            filterState = { status: 'all', verified: false, newOnly: false, ptsMin: null, ptsMax: null };
            document.getElementById('filterVerified').checked = false;
            document.getElementById('filterNew').checked = false;
            document.querySelectorAll('#filterStatusPills .filter-pill').forEach(p =>
                p.classList.toggle('active', p.dataset.status === 'all'));
            initFilterRange();
            updateFilterBadge();
            render();
        }

        function updateFilterBadge() {
            const active = filterState.status !== 'all' || filterState.verified || filterState.newOnly
                || filterState.ptsMin !== null || filterState.ptsMax !== null;
            document.getElementById('filterToggleBtn').classList.toggle('has-filters', active);
        }

        // Закрытие панели по клику вне её
        document.addEventListener('click', (e) => {
            const panel = document.getElementById('filterPanel');
            const btn = document.getElementById('filterToggleBtn');
            if (!panel || !panel.classList.contains('open')) return;
            if (!panel.contains(e.target) && !btn.contains(e.target)) {
                panel.classList.remove('open');
                btn.classList.remove('active');
            }
        });

        // ===== DRAG & DROP =====
        function handleDragStart(index, event) {
            if (!isDragDropMode || !canReorderCurrent()) { event.preventDefault(); return; }
            draggedIndex = index; 
            draggedItem = currentTab === 'demons' ? demons[index] : challenges[index];
            event.dataTransfer.setData('text/plain', index);
            event.dataTransfer.effectAllowed = 'move';
            event.currentTarget.classList.add('dragging');
        }
        function handleDragOver(index, event) {
            if (!isDragDropMode || draggedIndex === -1) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (index === draggedIndex) return;
            document.querySelectorAll('.card').forEach(c => c.classList.remove('drag-over','drag-over-before','drag-over-after'));
            event.currentTarget.classList.add('drag-over', index < draggedIndex ? 'drag-over-before' : 'drag-over-after');
        }
        function handleDragLeave(event) { event.currentTarget.classList.remove('drag-over','drag-over-before','drag-over-after'); }
        function handleDrop(targetIndex, event) {
            event.preventDefault();
            document.querySelectorAll('.card').forEach(c => c.classList.remove('drag-over','drag-over-before','drag-over-after'));
            if (!isDragDropMode || !canReorderCurrent() || draggedIndex === -1 || draggedIndex === targetIndex) return;
            
            const list = currentTab === 'demons' ? demons : challenges;
            const dbRef = currentTab === 'demons' ? '/demons/' : '/challenges/';
            const today = new Date().toISOString().slice(0,10);
            
            const newList = [...list];
            const dragged = newList[draggedIndex];
            newList.splice(draggedIndex, 1);
            newList.splice(targetIndex, 0, dragged);
            
            const updates = {};
            newList.forEach((item, idx) => {
                if (item.order !== idx) {
                    updates[`${dbRef}${item.key}/order`] = idx;
                    // Записываем снимок позиции в историю (для графика позиций)
                    const hKey = db.ref(`${dbRef}${item.key}/history`).push().key;
                    updates[`${dbRef}${item.key}/history/${hKey}`] = { pos: idx + 1, date: today };
                }
            });
            db.ref().update(updates).then(() => { showToast('✅ Порядок обновлён!'); });
            
            draggedIndex = -1; draggedItem = null;
        }
        function handleDragEnd(event) {
            event.currentTarget.classList.remove('dragging');
            document.querySelectorAll('.card').forEach(c => c.classList.remove('drag-over'));
            draggedIndex = -1; draggedItem = null;
        }

        function closeAllDropdowns() {
            document.querySelectorAll('.dropdown-content.show').forEach(d => d.classList.remove('show'));
        }

        // ===== PLAYER COUNTRIES =====
        // playerCountries: { 'NickName': 'RU' }  (ISO 3166-1 alpha-2)
        let playerCountries = {};
        let countryFilter = 'all';

        // ISO code -> emoji flag (works on all modern platforms via regional indicator letters)
        function countryFlag(code) {
            if (!code || code.length !== 2) return '';
            const offset = 0x1F1E6 - 65; // 'A' = 65
            return String.fromCodePoint(code.toUpperCase().charCodeAt(0) + offset) +
                   String.fromCodePoint(code.toUpperCase().charCodeAt(1) + offset);
        }

        // ===== LEVEL STATUS BADGES =====
        const STATUS_CONFIG = {
            legacy:  { icon: 'fa-arrow-down', labelRU: 'Легасится',     labelEN: 'Going Legacy' },
            watch:   { icon: 'fa-eye',         labelRU: 'Наблюдение',    labelEN: 'Under Watch'  },
            frozen:  { icon: 'fa-snowflake',   labelRU: 'Заморожен',     labelEN: 'Frozen'       },
        };
        function statusBadgeHtml(status) {
            const cfg = STATUS_CONFIG[status];
            if (!cfg) return '';
            const label = currentLang === 'EN' ? cfg.labelEN : cfg.labelRU;
            return `<div class="status-badge ${status}"><i class="fas ${cfg.icon}"></i>${label}</div>`;
        }

        // ===== SCORING FORMULA =====
        // Threshold: 60%. Below 60% — no points, entry not counted.
        // Internally set points = 100% score (ptsMax = pts as entered by moderator).
        // 60%–99%: ((perc - 60) / 40)^1.5 * ptsMax  (steep curve, rewards near-completions)
        // 100%: full ptsMax
        // Examples (ptsMax=10): 60%→0, 70%→1.41, 80%→3.97, 90%→7.13, 95%→8.52, 100%→10.00
        const MIN_PERC = 60;
        function calcPts(perc, levelPoints) {
            const ptsMax = parseFloat(levelPoints);
            if (isNaN(ptsMax) || perc < MIN_PERC) return 0;
            if (perc >= 100) return ptsMax;
            return ptsMax * Math.pow((perc - MIN_PERC) / (100 - MIN_PERC), 1.5);
        }

        // ===== PLAYER SEARCH =====
        let playerSearchDebounce = null;
        function debouncedPlayerSearch() {
            clearTimeout(playerSearchDebounce);
            playerSearchDebounce = setTimeout(renderPlayerSearch, 180);
        }

        function renderPlayerSearch() {
            const container = document.getElementById('playerSearchResults');
            if (!container) return;
            const query = (document.getElementById('playerSearchInput')?.value || '').trim().toLowerCase();
            const lbl = currentLang === 'EN';

            if (query.length < 2) {
                container.innerHTML = `<p style="color:#4b5563;text-align:center;padding:28px 0;font-size:0.88rem;">${lbl ? 'Type at least 2 characters to search' : 'Введите минимум 2 символа для поиска'}</p>`;
                return;
            }

            // Collect all unique players across demons + challenges
            const playerMap = {};
            const collectForSearch = (level, listType) => {
                getLevelEntries(level).forEach(v => {
                    const name = v.name ? v.name.trim() : '';
                    if (!name) return;
                    if (!playerMap[name]) playerMap[name] = { name, totalPoints: 0, completions: 0, records: 0, hardest: null, hardestIdx: Infinity };
                    const perc = parseInt((v.perc || '0').replace('%', ''));
                    if (perc < MIN_PERC) return;
                    playerMap[name].totalPoints += calcPts(perc, level.points);
                    if (perc >= 100) {
                        playerMap[name].completions++;
                        const allList = [...demons, ...challenges];
                        const idx = allList.indexOf(level);
                        if (idx < playerMap[name].hardestIdx) {
                            playerMap[name].hardestIdx = idx;
                            playerMap[name].hardest = level.name;
                        }
                    } else {
                        playerMap[name].records++;
                    }
                });
            };
            demons.forEach(d => collectForSearch(d, 'demons'));
            challenges.forEach(d => collectForSearch(d, 'challenges'));

            const results = Object.values(playerMap).filter(p => p.name.toLowerCase().includes(query));
            results.sort((a, b) => b.totalPoints - a.totalPoints);

            if (results.length === 0) {
                container.innerHTML = `<p style="color:#4b5563;text-align:center;padding:28px 0;font-size:0.88rem;">${lbl ? 'No players found' : 'Игроки не найдены'}</p>`;
                return;
            }

            // Full sorted leaderboard to get ranks
            const allSorted = Object.values(playerMap).sort((a, b) => b.totalPoints - a.totalPoints);

            container.innerHTML = results.map(p => {
                const rank = allSorted.findIndex(x => x.name === p.name) + 1;
                const pts = p.totalPoints < 0.01 ? '0' : p.totalPoints.toFixed(2);
                const flag = countryFlag(playerCountries[p.name.toLowerCase()]);
                return `<div class="player-top-card" onclick="openPlayerProfile('${p.name.replace(/'/g,"\\'")}')" style="cursor:pointer;margin-bottom:8px;">
                    <div class="player-top-rank ${rank===1?'rank-1':rank===2?'rank-2':rank===3?'rank-3':'rank-other'}">${rank<=3?['#1','#2','#3'][rank-1]:'#'+rank}</div>
                    <div class="player-top-avatar" style="font-size:1.3rem;">${flag || '&#127769;'}</div>
                    <div class="player-top-info" style="flex:1;min-width:0;">
                        <div class="player-top-name">${escapeHtml(p.name)}</div>
                        <div class="player-top-meta" style="display:flex;gap:12px;flex-wrap:wrap;">
                            <span><i class="fas fa-check" style="color:#4ade80;margin-right:4px;font-size:0.65rem;"></i>${p.completions} ${lbl?'compl.':'прохожд.'}</span>
                            ${p.records > 0 ? `<span><i class="fas fa-chart-line" style="color:#60a5fa;margin-right:4px;font-size:0.65rem;"></i>${p.records} ${lbl?'records':'рекордов'}</span>` : ''}
                            ${p.hardest ? `<span style="color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;" title="${p.hardest}"><i class="fas fa-fire" style="color:#fb923c;margin-right:4px;font-size:0.65rem;"></i>${p.hardest}</span>` : ''}
                        </div>
                    </div>
                    <div style="text-align:right;flex-shrink:0;">
                        <div class="player-top-points">${pts}</div>
                        <span class="player-top-pts-label">pts</span>
                    </div>
                </div>`;
            }).join('');
        }

        // ===== KEYBOARD NAVIGATION =====
        // Tracks which demon/challenge is open so arrows can navigate
        let currentModalKey = null;
        let currentModalType = 'demons';

        document.addEventListener('keydown', function(e) {
            // ESC: close any open modal/panel
            if (e.key === 'Escape') {
                const modals = [
                    'detailModal', 'playerProfileModal', 'editRecordModal',
                    'adminPanel', 'modPanel', 'editModal'
                ];
                for (const id of modals) {
                    const el = document.getElementById(id);
                    if (el && el.style.display !== 'none' && el.style.display !== '') {
                        el.style.display = 'none';
                        return;
                    }
                }
            }

            // Arrow keys: navigate between demons inside the detail modal
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                const modal = document.getElementById('detailModal');
                if (!modal || modal.style.display === 'none' || !currentModalKey) return;
                e.preventDefault();
                const list = currentModalType === 'demons' ? demons : challenges;
                const idx = list.findIndex(d => d.key === currentModalKey);
                if (idx === -1) return;
                const next = e.key === 'ArrowRight' ? idx + 1 : idx - 1;
                if (next < 0 || next >= list.length) return;
                showInfoByKey(list[next].key, currentModalType);
            }
        });

        // Загружает YouTube iframe только по клику на превью (оптимизация)
        function loadYtVideo(el, vid) {
            el.outerHTML = `<iframe src="https://www.youtube.com/embed/${vid}?autoplay=1" allowfullscreen allow="autoplay" loading="lazy"></iframe>`;
        }

        // Дебаунс поиска: рендер не чаще, чем раз в 150мс во время набора текста
        let searchDebounceTimer = null;
        function debouncedRender() {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(render, 150);
        }

        function showToast(message, duration = 2500) {
            const toast = document.getElementById('copyToast');
            toast.innerText = message; toast.className = 'show';
            setTimeout(() => toast.className = '', duration);
        }

        function toggleDragDropMode() {
            isDragDropMode = !isDragDropMode;
            const indicator = document.getElementById('dragIndicator');
            indicator.style.display = isDragDropMode ? 'flex' : 'none';
            render();
            showToast(isDragDropMode ? 'Drag & Drop режим включён' : 'Drag & Drop режим выключён');
        }

        // ===== ДОБАВЛЕНИЕ УРОВНЯ: ПОЗИЦИЯ + ЗАЩИТА ОТ ДУБЛЕЙ =====
        function normalizeLevelID(id) {
            return String(id ?? '').trim();
        }

        function findDuplicateLevelByID(levelID) {
            const id = normalizeLevelID(levelID);
            if (!id) return null;
            const demon = demons.find(d => normalizeLevelID(d.levelID) === id);
            if (demon) return { type: 'demons', item: demon };
            const challenge = challenges.find(c => normalizeLevelID(c.levelID) === id);
            if (challenge) return { type: 'challenges', item: challenge };
            return null;
        }

        function duplicateLevelMessage(dup, levelID) {
            const listName = dup.type === 'challenges' ? 'Challenge List' : 'Demon List';
            return `⚠️ Уровень с ID ${levelID} уже находится в ${listName}: ${dup.item.name || 'без названия'}`;
        }

        function populatePositionSelect(selectId, type, shouldUpdate = true) {
            if (!shouldUpdate) return;
            const sel = document.getElementById(selectId);
            if (!sel) return;
            const list = type === 'challenges' ? challenges : demons;
            const previous = sel.value;
            let html = '';
            for (let pos = 1; pos <= list.length; pos++) {
                const item = list[pos - 1];
                html += `<option value="${pos}">#${pos} — перед ${escapeHtml(item.name || 'уровнем')}</option>`;
            }
            html += `<option value="end">В конец (#${list.length + 1})</option>`;
            sel.innerHTML = html;
            if (previous && Array.from(sel.options).some(o => o.value === previous)) sel.value = previous;
            else sel.value = 'end';
        }

        function getInsertIndex(selectId, list) {
            const value = document.getElementById(selectId)?.value || 'end';
            if (value === 'end') return list.length;
            const pos = parseInt(value, 10);
            if (!Number.isFinite(pos)) return list.length;
            return Math.max(0, Math.min(list.length, pos - 1));
        }

        function addLevelAtPosition(type, data, insertIndex) {
            const list = type === 'challenges' ? challenges : demons;
            const safeIndex = Math.max(0, Math.min(list.length, insertIndex));
            const today = new Date().toISOString().slice(0, 10);
            const newRef = db.ref(type).push();
            const newHistoryKey = newRef.child('history').push().key;
            const updates = {};

            updates[`/${type}/${newRef.key}`] = {
                ...data,
                order: safeIndex,
                addedAt: Date.now(),
                history: { [newHistoryKey]: { pos: safeIndex + 1, date: today } }
            };

            // Всё, что было на выбранной позиции и ниже, сдвигаем на одну строку вниз.
            list.forEach((item, idx) => {
                const newOrder = idx >= safeIndex ? idx + 1 : idx;
                if (item.order !== newOrder) updates[`/${type}/${item.key}/order`] = newOrder;
                if (idx >= safeIndex) {
                    const hKey = db.ref(`${type}/${item.key}/history`).push().key;
                    updates[`/${type}/${item.key}/history/${hKey}`] = { pos: newOrder + 1, date: today };
                }
            });

            return db.ref().update(updates);
        }

        // Очистка истории только у одной карточки уровня. Оставлена admin-only, как и общая очистка.
        function clearItemPositionHistory(key, type = 'demons') {
            if (!isAdmin) { showToast('Только администратор может очищать историю позиций'); return; }
            const list = type === 'challenges' ? challenges : demons;
            const item = list.find(x => x.key === key);
            if (!item) return;
            const count = item.history ? Object.keys(item.history).length : 0;
            if (!count) { showToast('У этого уровня история позиций уже пустая'); return; }
            if (!confirm(`🧹 Очистить историю позиций уровня «${item.name}»?\n\nБудет удалено записей: ${count}. Это действие необратимо.`)) return;
            db.ref(`${type}/${key}/history`).remove()
                .then(() => showToast(`🧹 История «${item.name}» очищена`))
                .catch(e => showToast('Ошибка: ' + e.message));
        }

        // Очистка истории позиций (только админ) — удаляет узлы /history у всех уровней
        function clearPositionHistory() {
            if (!isAdmin) { alert('Только администратор!'); return; }
            if (!confirm('⚠️ Очистить историю позиций у ВСЕХ демонов и челленджей? Графики позиций будут сброшены. Действие необратимо!')) return;
            const updates = {};
            demons.forEach(d => { updates[`/demons/${d.key}/history`] = null; });
            challenges.forEach(c => { updates[`/challenges/${c.key}/history`] = null; });
            db.ref().update(updates)
                .then(() => { showToast('🧹 История позиций очищена!'); closeAdmin(); })
                .catch(e => showToast('Ошибка: ' + e.message));
        }

        // ===== LEVEL LIST VIEW MODE =====
        let levelViewMode = localStorage.getItem('nightLevelViewMode') === 'grid' ? 'grid' : 'rows';

        function syncLevelViewModeUI() {
            const container = document.getElementById('mainContainer');
            const rowsBtn = document.getElementById('viewRowsBtn');
            const gridBtn = document.getElementById('viewGridBtn');
            if (container) {
                container.classList.toggle('view-grid', levelViewMode === 'grid');
                container.classList.toggle('view-rows', levelViewMode === 'rows');
            }
            if (rowsBtn) rowsBtn.classList.toggle('active', levelViewMode === 'rows');
            if (gridBtn) gridBtn.classList.toggle('active', levelViewMode === 'grid');
        }

        function setLevelViewMode(mode) {
            levelViewMode = mode === 'grid' ? 'grid' : 'rows';
            localStorage.setItem('nightLevelViewMode', levelViewMode);
            syncLevelViewModeUI();
        }

        // ===== RENDER =====
        function render() {
            if (currentTab === 'players') { renderPlayerTop(); return; }
            if (currentTab === 'creatortop') { renderCreatorTop(); return; }
            
            const container = document.getElementById('mainContainer');
            syncLevelViewModeUI();
            const isDem = (currentTab === 'demons');
            const isChal = (currentTab === 'challenges');
            
            const query = document.getElementById('searchInput').value.toLowerCase();
            const topBanner = document.getElementById('top50Banner');
            
            container.innerHTML = '';
            container.style.display = 'grid';
            topBanner.style.display = isDem ? 'block' : 'none';

            const canEdit = canEditTab(currentTab);
            const canDelete = isAdmin;

            if(isDem || isChal) {
                const listToRender = isDem ? demons : challenges;
                const listType = isDem ? 'demons' : 'challenges';

                const now = Date.now();
                const filtered = listToRender.filter(d => {
                    // Поиск по названию, автору и тегу одновременно
                    if (query) {
                        const inName   = d.name.toLowerCase().includes(query);
                        const inAuthor = (d.author || '').toLowerCase().includes(query);
                        const inTag    = (d.tag || '').toLowerCase().includes(query);
                        if (!inName && !inAuthor && !inTag) return false;
                    }
                    // Статус
                    if (filterState.status !== 'all') {
                        if (filterState.status === 'none') { if (d.status) return false; }
                        else if (d.status !== filterState.status) return false;
                    }
                    // Только верифицированные
                    if (filterState.verified && !(d.verifier && d.verifier.trim())) return false;
                    // Только новые (добавлены за последние 7 дней)
                    if (filterState.newOnly && !(d.addedAt && (now - d.addedAt) <= NEW_LEVEL_MS)) return false;
                    // Диапазон баллов
                    const p = parseFloat(d.points);
                    if (filterState.ptsMin !== null && (isNaN(p) || p < filterState.ptsMin)) return false;
                    if (filterState.ptsMax !== null && (isNaN(p) || p > filterState.ptsMax)) return false;
                    return true;
                });

                const fragment = document.createDocumentFragment();
                filtered.forEach((d, i) => {
                    const realIndex = listToRender.findIndex(x => x.key === d.key);
                    const card = document.createElement('div');
                    card.className = 'card';
                    
                    if (isDragDropMode && canEdit) {
                        card.setAttribute('draggable', 'true');
                        card.setAttribute('data-index', i);
                        card.ondragstart = (e) => handleDragStart(i, e);
                        card.ondragover = (e) => handleDragOver(i, e);
                        card.ondragleave = handleDragLeave;
                        card.ondrop = (e) => handleDrop(i, e);
                        card.ondragend = handleDragEnd;
                    }

                    let adminHtml = '';
                    if (isDeleteMode && canDelete) {
                        adminHtml = `<div class="admin-controls">
                            <button class="ctrl-btn btn-up" onclick="moveItem(${i}, -1, '${listType}')"><i class="fas fa-arrow-up"></i></button>
                            <button class="ctrl-btn btn-down" onclick="moveItem(${i}, 1, '${listType}')"><i class="fas fa-arrow-down"></i></button>
                            <button class="ctrl-btn btn-edit" onclick="openEditModal('${d.key}', '${listType}')" title="Редактировать"><i class="fas fa-pen"></i></button>
                            ${isAdmin ? `<button class="ctrl-btn btn-history" onclick="event.stopPropagation(); clearItemPositionHistory('${d.key}', '${listType}')" title="Очистить историю позиций"><i class="fas fa-broom"></i></button>` : ''}
                            <button class="ctrl-btn btn-del" onclick="deleteItem('${d.key}', '${listType}')"><i class="fas fa-trash"></i></button>
                        </div>`;
                    } else if (isEditMode && canEdit) {
                        adminHtml = `<div class="admin-controls">
                            <button class="ctrl-btn btn-up" onclick="moveItem(${i}, -1, '${listType}')"><i class="fas fa-arrow-up"></i></button>
                            <button class="ctrl-btn btn-down" onclick="moveItem(${i}, 1, '${listType}')"><i class="fas fa-arrow-down"></i></button>
                            <button class="ctrl-btn btn-edit" onclick="openEditModal('${d.key}', '${listType}')" title="Редактировать"><i class="fas fa-pen"></i></button>
                            ${isAdmin ? `<button class="ctrl-btn btn-history" onclick="event.stopPropagation(); clearItemPositionHistory('${d.key}', '${listType}')" title="Очистить историю позиций"><i class="fas fa-broom"></i></button>` : ''}
                        </div>`;
                    }

                    // Points display: score at 80% and max (100%)
                    const pts = parseFloat(d.points);
                    const pts80 = !isNaN(pts) ? calcPts(80, pts).toFixed(2) : null;
                    const ptsMax = !isNaN(pts) ? pts.toFixed(2) : null;
                    const verifierName = (d.verifier || '').trim();

                    card.onclick = (event) => {
                        if (levelViewMode !== 'grid') return;
                        if (event.target.closest('button, a, .level-id-box, .admin-controls')) return;
                        showInfoByKey(d.key, listType);
                    };
                    card.title = currentLang === 'EN' ? 'Open level details' : 'Открыть информацию об уровне';

                    card.innerHTML = `
                        ${adminHtml}
                        <div class="card-img-wrap">
                            ${isDragDropMode && canEdit ? `<div style="position:absolute;top:6px;right:6px;background:rgba(167,139,250,0.2);padding:3px 7px;border-radius:5px;font-size:0.65rem;color:var(--accent);z-index:50;"><i class="fas fa-grip-vertical"></i></div>` : ''}
                            ${d.tag ? `<div class="demon-tag">${d.tag}</div>` : ''}
                            <img src="${d.img}" class="card-img" loading="lazy" decoding="async" alt="${escapeHtml(d.name)}" onerror="this.onerror=null;this.style.background='rgba(12,16,38,0.9)';this.style.display='flex';this.removeAttribute('src')">
                            ${verifierName ? `<div class="card-verified-stamp">VERIFIED</div>` : ''}
                            ${statusBadgeHtml(d.status)}
                        </div>
                        <div class="card-body">
                            <div class="card-rank-name">
                                <span class="card-rank">#${realIndex+1}</span>
                                <span class="card-title">${escapeHtml(d.name)}</span>
                            </div>
                            <div class="card-meta">
                                <span class="card-author">${d.author}</span>
                                ${verifierName ? `<span class="card-meta-sep">|</span><span class="card-verifier-name">${verifierName}</span>` : ''}
                                ${pts80 ? `<span class="card-meta-sep">·</span><span class="card-pts-val">${pts80}</span><span style="color:#4b5563;margin:0 3px;">&rarr;</span><span class="card-pts-max">${ptsMax}</span><span style="color:#4b5563;font-size:0.75rem;margin-left:3px;">pts</span>` : ''}
                            </div>
                            <div class="card-actions">
                                <div class="level-id-box" onclick="copyID('${d.levelID}')" style="margin:0; padding:6px 12px; font-size:0.78rem;"><i class="fas fa-hashtag" style="font-size:0.68rem;"></i> ${d.levelID}</div>
                                <button class="btn-more" onclick="showInfoByKey('${d.key}', '${listType}')" style="padding:7px 16px; font-size:0.78rem;">${currentLang==='EN'?'DETAILS':'ПОДРОБНЕЕ'}</button>
                            </div>
                        </div>`;
                    fragment.appendChild(card);
                });
                container.appendChild(fragment);
            }
        }

        // ===== PROCESS ADMIN ACTIONS =====
        function processAdmin() {
            const act = document.getElementById('admAction').value;

            if (act === 'set_country') {
                if (!isModerator) { alert('Нет доступа!'); return; }
                const nick = document.getElementById('countryNick').value.trim();
                const code = document.getElementById('countryCode').value.trim().toUpperCase();
                if (!nick || code.length !== 2) { showToast('Введи ник и 2-буквенный код страны'); return; }
                db.ref(`players/${nick}/country`).set(code).then(() => {
                    showToast(`Страна ${countryFlag(code)} ${code} сохранена для ${nick}`);
                    closeAdmin();
                }).catch(e => {
                    if (e.code === 'PERMISSION_DENIED' || (e.message && e.message.includes('PERMISSION_DENIED'))) {
                        showToast('Нет прав. Добавь правило в Firebase: "players": { ".read": true, ".write": "auth != null" }', 6000);
                    } else {
                        showToast('Ошибка: ' + e.message);
                    }
                });
                return;
            }

            if (act === 'add_victor') {
                if (!isModerator || (!isAdmin && !currentUserPermissions.canAddRecords)) { alert('Нет прав: добавление рекордов не разрешено!'); return; }
                const dKey = document.getElementById('selectDemon').value;
                const vicVidRaw = document.getElementById('vicVid').value.trim();
                let vicVid = vicVidRaw;
                if (vicVidRaw.includes('v=')) vicVid = vicVidRaw.split('v=')[1].split('&')[0];
                else if (vicVidRaw.includes('youtu.be/')) vicVid = vicVidRaw.split('youtu.be/')[1].split('?')[0];
                db.ref(`demons/${dKey}/victors`).push({
                    name: document.getElementById('vicName').value,
                    perc: document.getElementById('vicPerc').value,
                    att: document.getElementById('vicAtt').value,
                    vid: vicVid
                });
                closeAdmin();
                return;
            }

            if (act === 'add_victor_challenge') {
                if (!isModerator || (!isAdmin && !currentUserPermissions.canAddRecords)) { alert('Нет прав: добавление рекордов не разрешено!'); return; }
                const cKey = document.getElementById('selectChallenge').value;
                if (!cKey) { showToast('Нет доступных челленджей'); return; }
                const rawVid = document.getElementById('chalVicVid').value.trim();
                let chalVid = rawVid;
                if (rawVid.includes('v=')) chalVid = rawVid.split('v=')[1].split('&')[0];
                else if (rawVid.includes('youtu.be/')) chalVid = rawVid.split('youtu.be/')[1].split('?')[0];
                const name = document.getElementById('chalVicName').value.trim();
                const perc = document.getElementById('chalVicPerc').value.trim();
                if (!name || !perc) { showToast('Заполни ник и проценты'); return; }
                db.ref(`challenges/${cKey}/victors`).push({
                    name,
                    perc,
                    att: document.getElementById('chalVicAtt').value.trim(),
                    vid: chalVid
                }).then(() => {
                    showToast('Рекорд для челленджа добавлен!');
                    closeAdmin();
                }).catch(e => showToast('Ошибка: ' + e.message));
                return;
            }
            if (act === 'add_demon' || act === 'add_challenge') {
                if (act === 'add_demon'     && !isAdmin && !currentUserPermissions.canAddDemons)     { alert('Нет прав: добавление демонов не разрешено!'); return; }
                if (act === 'add_challenge' && !isAdmin && !currentUserPermissions.canAddChallenges) { alert('Нет прав: добавление челленджей не разрешено!'); return; }
                if (!isModerator) { alert('Нет доступа!'); return; }

                const targetDb = act === 'add_demon' ? 'demons' : 'challenges';
                const targetList = act === 'add_demon' ? demons : challenges;
                const levelID = normalizeLevelID(document.getElementById('itemID').value);
                const duplicate = findDuplicateLevelByID(levelID);
                if (duplicate) { showToast(duplicateLevelMessage(duplicate, levelID), 5500); return; }

                let r = document.getElementById('itemVid').value.trim();
                let v = r.includes('v=') ? r.split('v=')[1].split('&')[0] : r.includes('youtu.be/') ? r.split('youtu.be/')[1].split('?')[0] : r;
                const insertIndex = getInsertIndex('itemPosition', targetList);

                addLevelAtPosition(targetDb, {
                    name: document.getElementById('itemName').value.trim(),
                    author: document.getElementById('itemVal').value.trim(),
                    levelID,
                    tag: document.getElementById('itemTag').value.trim(),
                    verifier: document.getElementById('itemVerifier').value.trim(),
                    img: document.getElementById('itemImgURL').value.trim(),
                    vid: v,
                    points: document.getElementById('itemPoints').value.trim()
                }, insertIndex).then(() => {
                    showToast(`✅ Уровень добавлен на позицию #${insertIndex + 1}`);
                    closeAdmin();
                }).catch(e => showToast('Ошибка: ' + e.message));
                return;
            }
            if (act === 'edit_demon_mode') {
                if (!isModerator) { alert('Нет доступа!'); return; }
                isEditMode = !isEditMode;
                if (isEditMode) isDeleteMode = false;
                render();
                showToast(isEditMode ? '✏️ Режим редактирования включён' : '✏️ Режим редактирования выключён');
                closeAdmin();
                return;
            }
            if (act === 'drag_drop') {
                if (!isModerator) { alert('Нет доступа!'); return; }
                if (!isAdmin && !currentUserPermissions.canAddDemons && !currentUserPermissions.canAddChallenges) {
                    alert('Нет прав: перестановка уровней не разрешена!'); return;
                }
                toggleDragDropMode();
                closeAdmin();
                return;
            }

            // Admin-only actions
            if (!isAdmin) { alert('Только администратор!'); return; }

            if(act === 'add_creator') {
                db.ref('creators').push({ name: document.getElementById('itemName').value, points: parseInt(document.getElementById('itemVal').value) || 0 });
            } else if(act === 'delete_mode') {
                isDeleteMode = !isDeleteMode;
                if (isDeleteMode) isEditMode = false;
                render();
                showToast(isDeleteMode ? '🗑️ Режим удаления включён' : '🗑️ Режим удаления выключён');
            } else if(act === 'manage_mods') {
                closeAdmin();
                openModPanel();
                return;
            } else if(act === 'delete_all_demons') {
                if(confirm('⚠️ Удалить ВСЕХ демонов из списка? Это действие необратимо!')) { db.ref('demons').remove(); }
            } else if(act === 'maintenance') {
                db.ref('maintenance').once('value', s => {
                    const current = s.val() === true;
                    db.ref('maintenance').set(!current);
                    alert(!current ? '🔧 Техперерыв ВКЛЮЧЁН — сайт закрыт для посетителей' : '✅ Техперерыв ВЫКЛЮЧЕН — сайт открыт');
                });
            } else if(act === 'clear_history') {
                clearPositionHistory();
                return;
            }
            closeAdmin();
        }

        // ===== LANGUAGE =====
        // Keep old toggleLang for any legacy calls
        function toggleLang() { setLang(currentLang === 'RU' ? 'EN' : 'RU'); }

        function setLang(lang) {
            currentLang = lang;

            // Update navbar dropdown button display
            const flagMap = { RU: '&#127479;&#127482;', EN: '&#127468;&#127463;' };
            const flagEl = document.getElementById('langBtnFlag');
            const labelEl = document.getElementById('langBtnLabel');
            if (flagEl) flagEl.innerHTML = flagMap[lang];
            if (labelEl) labelEl.textContent = lang;

            // Update active state on desktop dropdown options
            document.querySelectorAll('.lang-opt').forEach(el => el.classList.remove('lang-opt-active'));
            const activeOpt = document.getElementById('langOpt' + lang);
            if (activeOpt) activeOpt.classList.add('lang-opt-active');

            // Update active state on mobile buttons
            ['RU', 'EN'].forEach(l => {
                const el = document.getElementById('mLang' + l);
                if (!el) return;
                if (l === lang) {
                    el.style.background = 'rgba(167,139,250,0.18)';
                    el.style.borderColor = 'rgba(167,139,250,0.5)';
                    el.style.color = 'var(--accent)';
                } else {
                    el.style.background = 'rgba(255,255,255,0.04)';
                    el.style.borderColor = 'rgba(255,255,255,0.08)';
                    el.style.color = '#6b7280';
                }
            });

            const translations = {
                RU: {
                    welcomeT: "NIGHT GDPS",
                    welcomeD: "Все в одном лишь сайте",
                    homeServerType: "Geometry Dash 2.2 Private Server",
                    homeVideoLabel: "Видео", homeTrailerTitle: "Трейлер Night GDPS",
                    homeReviewsLabel: "Отзывы", homeReviewsTitle: "Отзывы игроков", homeReviewsSub: "Отзывы о сервере.",
                    homeStatDemons: "демонов", homeStatChallenges: "челленджей", homeStatPlayers: "игроков", homeStatCreators: "креаторов",
                    homeQuickDemons: "Demon List", homeQuickChallenges: "Challenge List", homeQuickPlayers: "Top Slayers", homeQuickCreators: "Top Creators",
                    play: "СКАЧАТЬ", list: "DEMON LIST",
                    searchM: "Название / Автор", searchT: "По тегу", searchP: "Поиск уровня или автора...",
                    verify: "Критерии верификации", rate: "Критерии рейта", toast: "ID Скопировано!",
                    navLists: "Списки", navDownloadText: "Скачать", navHome: "Главная", navCriteria: "Критерии рейта",
                    dlTitle: "СКАЧАТЬ ИГРУ", dlVersion: "Версия 2.2081",
                    dlDescPC: "Скачать .zip архив для игры на компьютере",
                    dlDescAnd: "Скачать .apk файл для игры на телефоне",
                    tabDemons: "Демоны", tabChallenges: "Челленджи", tabPlayers: "Топ Слееров", tabCreators: "Топ Креаторов", tabPlayerSearch: "Поиск игрока",
                    navDropDemons: "Лист Демонов", navDropChallenges: "Лист Челленджей", navDropCreators: "Топ Креаторов", navDropPlayers: "Топ Слееров",
                    mNavLists: "Списки",
                    heroTitle: "DEMON LIST", heroBanner: "✦ ТОП 50 ✦",
                    profileCompletions: "Прохождений", profileRecords: "Рекордов",
                    profileBestDemon: "Лучший демон", profileBestPerc: "Макс. %",
                    profileCompTitle: "Прохождения", profileRecordsTitle: "Рекорды",
                    btnMoreLabel: "ПОДРОБНЕЕ", btnDetails: "ПОДРОБНЕЕ",
                    modText: "Модератор", dragActive: "Drag & Drop активен",
                    detailRecords: "Рекорды",
                    compareScore: "Очки", compareRank: "Ранк", compareComp: "Прохождений", compareRec: "Рекордов", compareHardest: "Хардест",
                    statsTitle: "СТАТИСТИКА СЕРВЕРА",
                    statsDemons: "Демоны", statsChallenges: "Челленджи", statsPlayers: "Игроки",
                    statsRecords: "Рекорды", statsCreators: "Создатели",
                    statsTopSlayer: "Топ Слеер", statsTopCreator: "Топ Создатель",
                    statsHardestDemon: "Сложнейший Демон", statsHardestChallenge: "Сложнейший Челлендж",
                    statsRecent: "Недавние изменения", statsListPos: "#1 в листе",
                    statsDemon: "Демон", statsChallenge: "Челлендж", statsUpdated: "Обновлено",
                    navStats: "Статистика",
                    compareTitle: "СРАВНЕНИЕ ИГРОКОВ", compareSub: "Выбери двух игроков для сравнения",
                    compareBtn: "Сравнить", compareBtnNav: "Сравнить игроков",
                    compareP1: "Игрок 1", compareP2: "Игрок 2",
                    filterTitle: "Фильтры", filterStatus: "Статус", filterPoints: "Баллы",
                    filterVerified: "Только верифицированные", filterNew: "Только новые", filterReset: "Сбросить фильтры",
                    fStatusAll: "Все", fStatusNone: "Активные", fStatusLegacy: "Легасится", fStatusWatch: "Наблюдение", fStatusFrozen: "Заморожен",
                    searchPlaceholder: "Поиск уровня, автора или тега..."
                },
                EN: {
                    welcomeT: "NIGHT GDPS",
                    welcomeD: "Everything in one website",
                    homeServerType: "Geometry Dash 2.2 Private Server",
                    homeVideoLabel: "Video", homeTrailerTitle: "Night GDPS Trailer",
                    homeReviewsLabel: "Reviews", homeReviewsTitle: "Player reviews", homeReviewsSub: "Server reviews.",
                    homeStatDemons: "demons", homeStatChallenges: "challenges", homeStatPlayers: "players", homeStatCreators: "creators",
                    homeQuickDemons: "Demon List", homeQuickChallenges: "Challenge List", homeQuickPlayers: "Top Slayers", homeQuickCreators: "Top Creators",
                    play: "DOWNLOAD", list: "DEMON LIST",
                    searchM: "Name / Author", searchT: "By Tag", searchP: "Search level or creator...",
                    verify: "Verification Criteria", rate: "Rate Criteria", toast: "ID Copied!",
                    navLists: "Lists", navDownloadText: "Download", navHome: "Home", navCriteria: "Rate Criteria",
                    dlTitle: "DOWNLOAD GAME", dlVersion: "Version 2.2081",
                    dlDescPC: "Download .zip archive to play on PC",
                    dlDescAnd: "Download .apk file to play on mobile",
                    tabDemons: "Demons", tabChallenges: "Challenges", tabPlayers: "Top Slayers", tabCreators: "Top Creators", tabPlayerSearch: "Player Search",
                    navDropDemons: "Demon List", navDropChallenges: "Challenge List", navDropCreators: "Top Creators", navDropPlayers: "Top Slayers",
                    mNavLists: "Lists",
                    heroTitle: "DEMON LIST", heroBanner: "✦ TOP 50 ✦",
                    profileCompletions: "Completions", profileRecords: "Records",
                    profileBestDemon: "Best Demon", profileBestPerc: "Max %",
                    profileCompTitle: "Completions", profileRecordsTitle: "Records",
                    btnMoreLabel: "DETAILS", btnDetails: "DETAILS",
                    modText: "Moderator", dragActive: "Drag & Drop active",
                    detailRecords: "Records",
                    compareScore: "Score", compareRank: "Rank", compareComp: "Completions", compareRec: "Records", compareHardest: "Hardest",
                    statsTitle: "SERVER STATISTICS",
                    statsDemons: "Demons", statsChallenges: "Challenges", statsPlayers: "Players",
                    statsRecords: "Records", statsCreators: "Creators",
                    statsTopSlayer: "Top Slayer", statsTopCreator: "Top Creator",
                    statsHardestDemon: "Hardest Demon", statsHardestChallenge: "Hardest Challenge",
                    statsRecent: "Recent Changes", statsListPos: "#1 on the list",
                    statsDemon: "Demon", statsChallenge: "Challenge", statsUpdated: "Updated",
                    navStats: "Statistics",
                    compareTitle: "PLAYER COMPARISON", compareSub: "Select two players to compare",
                    compareBtn: "Compare", compareBtnNav: "Compare Players",
                    compareP1: "Player 1", compareP2: "Player 2",
                    filterTitle: "Filters", filterStatus: "Status", filterPoints: "Points",
                    filterVerified: "Verified only", filterNew: "New only", filterReset: "Reset filters",
                    fStatusAll: "All", fStatusNone: "Active", fStatusLegacy: "Going Legacy", fStatusWatch: "Under Watch", fStatusFrozen: "Frozen",
                    searchPlaceholder: "Search level, author or tag..."
                }
            };
            const t = translations[lang];

            const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };

            // Hero / home
            set('welcomeTitle', t.welcomeT);
            set('welcomeDesc', t.welcomeD);
            set('homeServerType', t.homeServerType);
            set('homeVideoLabel', t.homeVideoLabel);
            set('homeTrailerTitle', t.homeTrailerTitle);
            set('homeReviewsLabel', t.homeReviewsLabel);
            set('homeReviewsTitle', t.homeReviewsTitle);
            set('homeReviewsSub', t.homeReviewsSub);
            set('homeStatDemonsLabel', t.homeStatDemons);
            set('homeStatChallengesLabel', t.homeStatChallenges);
            set('homeStatPlayersLabel', t.homeStatPlayers);
            set('homeStatCreatorsLabel', t.homeStatCreators);
            set('homeQuickDemons', t.homeQuickDemons);
            set('homeQuickChallenges', t.homeQuickChallenges);
            set('homeQuickPlayers', t.homeQuickPlayers);
            set('homeQuickCreators', t.homeQuickCreators);
            set('btnPlay', t.play);
            set('btnList', t.list);
            set('verifyLink', t.verify);
            set('rateLink', t.rate);

            // Moderator indicator
            set('modIndicatorText', t.modText);

            // Tab labels (list section)
            set('tabDemonsLabel', t.tabDemons);
            set('tabChallengesLabel', t.tabChallenges);
            set('tabPlayersLabel', t.tabPlayers);
            set('tabCreatorsLabel', t.tabCreators);
            set('tabPlayerSearchLabel', t.tabPlayerSearch);

            // Nav dropdown labels
            set('navDropDemonsLabel', t.navDropDemons);
            set('navDropChallengesLabel', t.navDropChallenges);
            set('navDropCreatorsLabel', t.navDropCreators);
            set('navDropPlayersLabel', t.navDropPlayers);

            // Mobile nav labels
            set('mNavLists', t.mNavLists);
            set('mNavDemons', t.navDropDemons);
            set('mNavChallenges', t.navDropChallenges);
            set('mNavCreators', t.navDropCreators);
            set('mNavPlayers', t.navDropPlayers);

            // Download section
            set('dlTitle', t.dlTitle);
            set('dlVersion', t.dlVersion);
            set('dlDescPC', t.dlDescPC);
            set('dlDescAnd', t.dlDescAnd);

            // Profile modal static labels
            set('labelCompletions', t.profileCompletions);
            set('labelRecords', t.profileRecords);
            set('labelBestDemon', t.profileBestDemon);
            set('labelBestPerc', t.profileBestPerc);
            set('profileCompTitle', t.profileCompTitle);
            set('profileRecordsTitle', t.profileRecordsTitle);

            // Stats section
            set('statsPageTitle', t.statsTitle);
            set('statLabelDemons', t.statsDemons);
            set('statLabelChallenges', t.statsChallenges);
            set('statLabelPlayers', t.statsPlayers);
            set('statLabelRecords', t.statsRecords);
            set('statLabelCreators', t.statsCreators);
            set('statLabelTopSlayer', t.statsTopSlayer);
            set('statLabelTopCreator', t.statsTopCreator);
            set('statLabelHardestDemon', t.statsHardestDemon);
            set('statLabelHardestChallenge', t.statsHardestChallenge);
            set('statLabelRecent', t.statsRecent);
            set('statLabelHardestDemonPos', t.statsListPos);
            set('statLabelHardestChallengePos', t.statsListPos);
            set('navStats', t.navStats);
            set('compareTitleEl', t.compareTitle);
            set('compareSubEl', t.compareSub);
            set('compareBtnRun', t.compareBtn);
            set('compareBtnNav', t.compareBtnNav);
            set('compareTagA', t.compareP1);
            set('compareTagB', t.compareP2);

            // Filter panel
            set('filterTitleLbl', t.filterTitle);
            set('filterStatusLbl', t.filterStatus);
            set('filterPtsLbl', t.filterPoints);
            set('filterVerLbl', t.filterVerified);
            set('filterNewLbl', t.filterNew);
            set('filterResetBtn', t.filterReset);
            set('fpStatusAll', t.fStatusAll);
            set('fpStatusNone', t.fStatusNone);
            set('fpStatusLegacy', t.fStatusLegacy);
            set('fpStatusWatch', t.fStatusWatch);
            set('fpStatusFrozen', t.fStatusFrozen);
            const searchInputEl = document.getElementById('searchInput');
            if (searchInputEl) searchInputEl.placeholder = t.searchPlaceholder;

            render();
        }

        // ===== DETAIL MODAL =====
        function showInfoByKey(key, type = 'demons') {
            // Track for arrow key navigation
            currentModalKey = key;
            currentModalType = type;

            const list = type === 'demons' ? demons : challenges;
            const d = list.find(x => x.key === key);
            const realIndex = list.indexOf(d);

            // Points display: score at 80% threshold and max (100%)
            const pts = parseFloat(d.points);
            const pts80 = !isNaN(pts) ? calcPts(80, pts).toFixed(2) : null;
            const ptsMax = !isNaN(pts) ? pts.toFixed(2) : null;

            // Records list
            const victorEntries = d.victors ? Object.entries(d.victors) : [];
            const vicsHtml = victorEntries.length > 0
                ? victorEntries.map(([vk, v]) => `
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;">
                        <div style="display:flex;flex-direction:column;gap:5px;flex:1;min-width:0;">
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                <b style="color:#fff;cursor:pointer;font-size:0.92rem;" onclick="document.getElementById('detailModal').style.display='none'; openPlayerProfile('${escapeHtml(v.name)}')">${escapeHtml(v.name)}</b>
                                <span style="background:rgba(167,139,250,0.12);color:var(--accent);font-size:0.72rem;font-weight:900;padding:2px 8px;border-radius:6px;font-family:'Orbitron';">${v.perc || '100%'}</span>
                                ${v.att ? `<span style="color:#4b5563;font-size:0.75rem;">${v.att} att</span>` : ''}
                            </div>
                            ${v.vid ? `<a href="https://youtube.com/watch?v=${v.vid}" target="_blank" style="display:inline-flex;align-items:center;gap:5px;background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.25);color:#f87171;padding:3px 9px;border-radius:6px;font-size:0.72rem;font-weight:700;text-decoration:none;width:fit-content;"><i class="fab fa-youtube"></i> Видео</a>` : ''}
                        </div>
                        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
                            ${isEditMode && isModerator ? `<button style="background:transparent;border:none;color:#f39c12;cursor:pointer;font-size:0.9rem;" onclick="openEditRecordModal('${d.key}','${vk}','${type}')"><i class="fas fa-pen"></i></button>` : ''}
                            ${isDeleteMode && isAdmin ? `<button style="background:transparent;border:none;color:#ff4d4d;cursor:pointer;font-size:0.9rem;" onclick="deleteVictor('${d.key}','${vk}','${type}')"><i class="fas fa-trash"></i></button>` : ''}
                        </div>
                    </div>`).join('')
                : `<p style="color:#4b5563;text-align:center;padding:20px 0;font-size:0.88rem;">${currentLang==='EN'?'No records yet':'Рекордов пока нет'}</p>`;

            // Build position history SVG chart
            const historyData = d.history ? Object.values(d.history).sort((a,b) => (a.date||'').localeCompare(b.date||'')) : [];
            const historyHtml = (() => {
                if (historyData.length < 2) {
                    return historyData.length === 0
                        ? `<p style="color:#4b5563;font-size:0.78rem;text-align:center;padding:10px 0;">${currentLang==='EN'?'No position history yet':'История позиций пока не записана'}</p>`
                        : '';
                }
                const W = 400, H = 100, PAD = 28, LABEL_TOP = 14, LABEL_BOT = 12;
                const positions = historyData.map(h => h.pos);
                const minPos = Math.min(...positions);
                const maxPos = Math.max(...positions);
                const range = maxPos === minPos ? 1 : maxPos - minPos;
                const xStep = (W - PAD * 2) / Math.max(historyData.length - 1, 1);
                // Позиция Y: меньший номер = выше (топ 1 = верх)
                const toY = p => LABEL_TOP + ((p - minPos) / range) * (H - LABEL_TOP - LABEL_BOT);
                const points = historyData.map((h, i) => `${PAD + i * xStep},${toY(h.pos)}`).join(' ');
                const firstPos = positions[0], lastPos = positions[positions.length - 1];
                const trend = lastPos < firstPos ? '#4ade80' : lastPos > firstPos ? '#f87171' : '#a78bfa';
                const dots = historyData.map((h, i) => {
                    const x = PAD + i * xStep, y = toY(h.pos);
                    const dateLabel = h.date ? h.date.slice(5) : '';
                    return `
                        <circle cx="${x}" cy="${y}" r="4.5" fill="${trend}" stroke="#111827" stroke-width="2"/>
                        <text x="${x}" y="${y - 8}" text-anchor="middle" font-size="10" font-weight="700" fill="${trend}">#${h.pos}</text>
                        <text x="${x}" y="${H}" text-anchor="middle" font-size="8.5" fill="#4b5563">${dateLabel}</text>
                        <title>#${h.pos} — ${h.date||''}</title>`;
                }).join('');
                return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;overflow:visible;" role="img" aria-label="Position history">
                    <polyline points="${points}" fill="none" stroke="${trend}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.7"/>
                    ${dots}
                </svg>`;
            })();

            document.getElementById('modalData').innerHTML = `
                <button class="modal-close-pin" onclick="document.getElementById('detailModal').style.display='none'; history.replaceState(null,'',window.location.pathname+window.location.search)">
                    <i class="fas fa-times"></i>
                </button>
                <button class="modal-close-pin" onclick="copyDemonLink()" title="${currentLang==='EN'?'Copy link':'Скопировать ссылку'}" style="right:56px;background:rgba(59,130,246,0.12);border-color:rgba(59,130,246,0.3);color:#60a5fa;" id="shareDemonBtn">
                    <i class="fas fa-link"></i>
                </button>

                <!-- Arrow navigation -->
                ${realIndex > 0 ? `<button onclick="showInfoByKey('${list[realIndex-1].key}','${type}')" title="${currentLang==='EN'?'Previous':'Предыдущий'}" style="position:absolute;top:50%;left:-16px;transform:translateY(-50%);background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.25);color:var(--accent);width:32px;height:32px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.85rem;transition:background 0.2s;z-index:10;" onmouseover="this.style.background='rgba(167,139,250,0.25)'" onmouseout="this.style.background='rgba(167,139,250,0.12)'"><i class="fas fa-chevron-left"></i></button>` : ''}
                ${realIndex < list.length - 1 ? `<button onclick="showInfoByKey('${list[realIndex+1].key}','${type}')" title="${currentLang==='EN'?'Next':'Следующий'}" style="position:absolute;top:50%;right:-16px;transform:translateY(-50%);background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.25);color:var(--accent);width:32px;height:32px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:0.85rem;transition:background 0.2s;z-index:10;" onmouseover="this.style.background='rgba(167,139,250,0.25)'" onmouseout="this.style.background='rgba(167,139,250,0.12)'"><i class="fas fa-chevron-right"></i></button>` : ''}

                <!-- Status badge if present -->
                ${d.status && STATUS_CONFIG[d.status] ? (() => { const cfg = STATUS_CONFIG[d.status]; const lbl = currentLang==='EN'?cfg.labelEN:cfg.labelRU; return `<div style="display:flex;justify-content:center;margin-bottom:10px;"><span class="status-badge ${d.status}" style="position:relative;top:auto;right:auto;"><i class="fas ${cfg.icon}"></i>${lbl}</span></div>`; })() : ''}

                <!-- Header: rank + name -->
                <div style="text-align:center;margin:0 44px 16px 0;">
                    <div style="display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;">
                        <span style="background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.3);color:var(--accent);font-family:'Orbitron';font-weight:900;font-size:0.8rem;padding:4px 12px;border-radius:8px;">#${realIndex + 1}</span>
                        <h2 style="font-family:'Orbitron';font-size:clamp(1.1rem,4vw,1.6rem);font-weight:900;color:#fff;margin:0;">${escapeHtml(d.name)}</h2>
                    </div>
                    <p style="color:#6b7280;font-size:0.82rem;margin:6px 0 0;">created by <span style="color:#94a3b8;font-weight:700;">${d.author}</span></p>
                </div>

                <!-- Verified by banner -->
                ${d.verifier ? `
                <div style="display:flex;align-items:center;justify-content:center;gap:8px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:10px;padding:10px 18px;margin-bottom:16px;">
                    <i class="fas fa-check-circle" style="color:#4ade80;font-size:1rem;"></i>
                    <span style="font-size:0.88rem;color:#86efac;">${currentLang === 'EN' ? 'Verified by' : 'Верифицировано'} <b style="color:#4ade80;font-weight:900;cursor:pointer;text-decoration:underline;text-decoration-color:rgba(74,222,128,0.4);" onclick="document.getElementById('detailModal').style.display='none'; openPlayerProfile('${d.verifier}')">${d.verifier}</b></span>
                </div>` : ''}

                <!-- Video -->
                ${d.vid ? `<div style="position:relative;width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;margin-bottom:16px;border:1px solid rgba(167,139,250,0.15);">
                    <iframe style="position:absolute;inset:0;width:100%;height:100%;border:none;" src="https://www.youtube.com/embed/${d.vid}" frameborder="0" allowfullscreen loading="lazy"></iframe>
                </div>` : ''}

                <!-- Stats grid -->
                <div style="display:grid;grid-template-columns:${pts80 ? '1fr 1fr 1fr' : '1fr'};gap:10px;margin-bottom:18px;">
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:14px;text-align:center;cursor:pointer;" onclick="copyID('${d.levelID}')">
                        <div style="font-size:0.62rem;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">ID</div>
                        <div style="font-family:'Orbitron';font-size:1rem;font-weight:900;color:#fff;margin-bottom:4px;">${d.levelID}</div>
                        <div style="font-size:0.68rem;color:var(--accent);display:flex;align-items:center;justify-content:center;gap:4px;"><i class="fas fa-copy"></i> ${currentLang === 'EN' ? 'Click to copy' : 'Нажми чтобы скопировать'}</div>
                    </div>
                    ${pts80 ? `
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:14px;text-align:center;">
                        <div style="font-size:0.62rem;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">${currentLang === 'EN' ? 'Max Score (100%)' : 'Макс. очки (100%)'}</div>
                        <div style="font-family:'Orbitron';font-size:1rem;font-weight:900;color:var(--accent);">${ptsMax}</div>
                    </div>
                    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:14px;text-align:center;">
                        <div style="font-size:0.62rem;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;">${currentLang === 'EN' ? 'Score at 80%' : 'Очки за 80%'}</div>
                        <div style="font-family:'Orbitron';font-size:1rem;font-weight:900;color:#60a5fa;">${pts80}</div>
                    </div>` : ''}
                </div>

                <!-- Records section -->
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                    <i class="fas fa-trophy" style="color:#fbbf24;font-size:0.9rem;"></i>
                    <span style="font-size:0.78rem;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:1.5px;">${currentLang==='EN'?'Records':'Рекорды'}</span>
                    <span style="font-size:0.72rem;color:#4b5563;">${victorEntries.length} total</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;padding-right:4px;">${vicsHtml}</div>

                <!-- Position history chart -->
                ${historyData.length > 0 ? `
                <div style="margin-top:20px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:14px 16px;">
                    <div style="display:flex;align-items:center;gap:7px;margin-bottom:10px;">
                        <i class="fas fa-chart-line" style="color:var(--accent);font-size:0.8rem;"></i>
                        <span style="font-size:0.72rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1.5px;">${currentLang==='EN'?'Position History':'История позиций'}</span>
                    </div>
                    ${historyHtml}
                </div>` : ''}
                `;
                
            // Update URL hash so the link is shareable
            history.replaceState(null, '', `#${type === 'challenges' ? 'challenge' : 'demon'}/${key}`);

            document.getElementById('detailModal').style.display='block';
            document.getElementById('detailModal').scrollTop = 0;
        }

        function openEditRecordModal(dKey, vKey, type) {
            const list = type === 'demons' ? demons : challenges;
            const d = list.find(x => x.key === dKey);
            const v = d.victors[vKey];
            
            document.getElementById('editRecDemonKey').value = dKey;
            document.getElementById('editRecKey').value = vKey;
            document.getElementById('editRecType').value = type;
            
            document.getElementById('editRecName').value = v.name || '';
            document.getElementById('editRecPerc').value = v.perc || '';
            document.getElementById('editRecAtt').value = v.att || '';
            document.getElementById('editRecVid').value = v.vid ? `https://youtube.com/watch?v=${v.vid}` : '';
            
            document.getElementById('editRecordModal').style.display = 'block';
        }

        function saveRecordEdit() {
            const type = document.getElementById('editRecType').value;
            const dKey = document.getElementById('editRecDemonKey').value;
            const vKey = document.getElementById('editRecKey').value;
            
            let mVidRaw = document.getElementById('editRecVid').value.trim();
            let mVid = mVidRaw;
            if (mVidRaw.includes('v=')) mVid = mVidRaw.split('v=')[1].split('&')[0];
            else if (mVidRaw.includes('youtu.be/')) mVid = mVidRaw.split('youtu.be/')[1].split('?')[0];

            db.ref(`${type}/${dKey}/victors/${vKey}`).update({
                name: document.getElementById('editRecName').value.trim(),
                perc: document.getElementById('editRecPerc').value.trim(),
                att: document.getElementById('editRecAtt').value.trim(),
                vid: mVid
            }).then(() => {
                showToast('✅ Рекорд обновлен!');
                document.getElementById('editRecordModal').style.display = 'none';
                showInfoByKey(dKey, type); 
            }).catch(e => showToast('Ошибка: ' + e.message));
        }

        // ===== UTILS =====
        function deleteVictor(dk, vk, type = 'demons') {
            if(confirm(currentLang==='EN'?"Delete record?":"Удалить рекорд?")) {
                db.ref(`${type}/${dk}/victors/${vk}`).remove().then(() => { 
                    document.getElementById('detailModal').style.display='none'; 
                    showToast('🗑️ Рекорд удален');
                });
            }
        }
        function copyID(id) { navigator.clipboard.writeText(id); const t = document.getElementById("copyToast"); t.className = "show"; setTimeout(() => t.className = "", 3000); }
        function moveItem(index, dir, type = 'demons') { 
            const list = type === 'demons' ? demons : challenges;
            let target = index + dir; 
            if (target < 0 || target >= list.length) return;
            const updates = {}; 
            updates[`/${type}/${list[index].key}/order`] = target; 
            updates[`/${type}/${list[target].key}/order`] = index;
            // Record a history snapshot for both affected items
            const today = new Date().toISOString().slice(0,10);
            const snapA = db.ref(`/${type}/${list[index].key}/history`).push();
            const snapB = db.ref(`/${type}/${list[target].key}/history`).push();
            snapA.set({ pos: target + 1, date: today });
            snapB.set({ pos: index + 1, date: today });
            db.ref().update(updates); 
        }
        function toggleAdmFields() {
            const a = document.getElementById('admAction').value;
            document.getElementById('fields_main').style.display = (a === 'add_demon' || a === 'add_challenge' || a === 'add_creator') ? 'block' : 'none';
            document.getElementById('fields_demon').style.display = (a === 'add_demon' || a === 'add_challenge') ? 'block' : 'none';
            document.getElementById('fields_victor').style.display = a === 'add_victor' ? 'block' : 'none';
            document.getElementById('fields_victor_challenge').style.display = a === 'add_victor_challenge' ? 'block' : 'none';
            document.getElementById('fields_country').style.display = a === 'set_country' ? 'block' : 'none';
            if (a === 'add_demon') populatePositionSelect('itemPosition', 'demons');
            if (a === 'add_challenge') populatePositionSelect('itemPosition', 'challenges');
        }
        function closeAdmin() { document.getElementById('adminPanel').style.display='none'; }
        
        function switchTab(t, remember = true) {
            if (!VALID_LIST_TABS.has(t)) return;
            currentTab = t;
            if (remember) {
                try {
                    localStorage.setItem(NAV_SECTION_KEY, 'listSection');
                    localStorage.setItem(NAV_TAB_KEY, t);
                } catch (e) {}
            }
            const tabs = {
                demons: 'tabDemonsBtn', challenges: 'tabChallengesBtn',
                creators: 'tabCreatorsBtn', players: 'tabPlayersBtn',
                creatortop: 'tabCreatorTopBtn', playersearch: 'tabPlayerSearchBtn'
            };
            Object.entries(tabs).forEach(([key, btnId]) => {
                const btn = document.getElementById(btnId);
                if (btn) btn.classList.toggle('active', key === t);
            });
            const mainContainer       = document.getElementById('mainContainer');
            const playerTopSection    = document.getElementById('playerTopSection');
            const creatorTopSection   = document.getElementById('creatorTopSection');
            const playerSearchSection = document.getElementById('playerSearchSection');
            const searchBoxWrap       = document.getElementById('searchBoxWrap');
            const top50Banner         = document.getElementById('top50Banner');

            if (mainContainer) mainContainer.style.display = 'none';
            if (playerTopSection) playerTopSection.style.display = 'none';
            if (creatorTopSection) creatorTopSection.style.display = 'none';
            if (playerSearchSection) playerSearchSection.style.display = 'none';
            if (searchBoxWrap) searchBoxWrap.style.display = 'none';
            if (top50Banner) top50Banner.style.display = 'none';

            if (t === 'players') {
                if (playerTopSection) playerTopSection.style.display = 'block';
                document.getElementById('txtHero').innerText = currentLang === 'EN' ? 'SLAYERS TOP' : 'ТОП СЛЕЕРОВ';
                renderPlayerTop();
            } else if (t === 'creatortop') {
                if (creatorTopSection) creatorTopSection.style.display = 'block';
                document.getElementById('txtHero').innerText = currentLang === 'EN' ? 'CREATOR TOP' : 'ТОП КРЕАТОРОВ';
                renderCreatorTop();
            } else if (t === 'playersearch') {
                if (playerSearchSection) playerSearchSection.style.display = 'block';
                document.getElementById('txtHero').innerText = currentLang === 'EN' ? 'PLAYER SEARCH' : 'ПОИСК ИГРОКА';
                renderPlayerSearch();
            } else {
                if (mainContainer) mainContainer.style.display = 'grid';
                if (searchBoxWrap) searchBoxWrap.style.display = 'block';
                if (t === 'demons') document.getElementById('txtHero').innerText = currentLang === 'EN' ? 'DEMON LIST' : 'СПИСОК ДЕМОНОВ';
                if (t === 'challenges') document.getElementById('txtHero').innerText = currentLang === 'EN' ? 'CHALLENGE LIST' : 'ЧЕЛЛЕНДЖИ';
                render();
            }
        }

        let creatorCountryFilter = 'all';

        function renderCreatorTop() {
            const list = document.getElementById('creatorTopList');
            if (!list) return;
            const lbl = currentLang === 'EN';

            const sorted = [...creators].sort((a, b) => parseInt(b.points) - parseInt(a.points));

            if (sorted.length === 0) {
                list.innerHTML = `<div class="player-top-empty">${lbl ? 'No creators yet.' : 'Рейтинг пуст. Добавьте создателей!'}</div>`;
                return;
            }

            // Country filter dropdown
            const usedCountries = [...new Set(
                sorted.map(c => playerCountries[c.name.toLowerCase()]).filter(Boolean)
            )].sort();
            const filterWrap = document.getElementById('creatorCountryFilterWrap');
            if (filterWrap) {
                if (usedCountries.length > 0) {
                    const opts = [`<option value="all">${lbl ? 'All countries' : 'Все страны'}</option>`]
                        .concat(usedCountries.map(c => `<option value="${c}">${countryFlag(c)} ${c}</option>`))
                        .join('');
                    filterWrap.innerHTML = `<select onchange="creatorCountryFilter=this.value;renderCreatorTop();" style="background:#0f1225;border:1px solid rgba(167,139,250,0.25);color:#e2d4f0;padding:8px 14px;border-radius:10px;font-family:'Nunito';font-size:0.85rem;cursor:pointer;outline:none;">${opts}</select>`;
                    filterWrap.querySelector('select').value = creatorCountryFilter;
                } else {
                    filterWrap.innerHTML = '';
                }
            }

            const filtered = creatorCountryFilter === 'all'
                ? sorted
                : sorted.filter(c => (playerCountries[c.name.toLowerCase()] || '') === creatorCountryFilter);

            if (filtered.length === 0) {
                list.innerHTML = `<div class="player-top-empty">${lbl ? 'No creators for this country.' : 'Нет создателей для этой страны.'}</div>`;
                return;
            }

            const medals = ['#1', '#2', '#3'];
            list.innerHTML = filtered.map((c, i) => {
                const rank = i + 1;
                const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-other';
                const rankDisplay = rank <= 3 ? medals[rank - 1] : `#${rank}`;
                const flag = countryFlag(playerCountries[c.name.toLowerCase()]);

                let adminBtns = '';
                if (isAdmin) {
                    if (isEditMode) adminBtns += `<button class="ctrl-btn btn-edit" onclick="event.stopPropagation(); openEditCreatorModal('${c.key}')" style="margin-right:6px;"><i class="fas fa-pen"></i></button>`;
                    if (isDeleteMode) adminBtns += `<button class="ctrl-btn btn-del" onclick="event.stopPropagation(); deleteItem('${c.key}','creators')"><i class="fas fa-trash"></i></button>`;
                }

                return `<div class="player-top-card creator-profile-card" onclick="openPlayerProfile('${c.name.replace(/'/g, "\\'")}')" title="${lbl ? 'Open profile' : 'Открыть профиль'}">
                    <div class="player-top-rank ${rankClass}">${rankDisplay}</div>
                    <div class="player-top-avatar" style="font-size:1.3rem;">${flag || '<i class="fas fa-hammer" style="font-size:1rem;color:#a78bfa;"></i>'}</div>
                    <div class="player-top-info">
                        <div class="player-top-name">${escapeHtml(c.name)}</div>
                        <div class="player-top-meta">${lbl ? 'Creator' : 'Создатель'}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        ${adminBtns !== '' ? `<div style="display:flex;">${adminBtns}</div>` : ''}
                        <div>
                            <div class="player-top-points">${c.points}</div>
                            <span class="player-top-pts-label">CP</span>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        // Возвращает все записи игроков для уровня, включая верифера как 100% прохождение.
        // Если верифер уже записан в victors (например, сам себя верифнул) — запись просто помечается меткой "Верифер",
        // но баллы НЕ начисляются повторно, остаются как есть. Отдельная запись создаётся только если верифера ещё нет в списке.
        function getLevelEntries(level) {
            const vName = (level.verifier || '').trim();
            const entries = level.victors
                ? Object.values(level.victors)
                    .filter(v => v.name && v.name.trim())
                    .map(v => vName && v.name.trim().toLowerCase() === vName.toLowerCase()
                        ? { ...v, isVerifier: true }   // метка есть, но баллы/проценты не меняются
                        : v)
                : [];
            if (vName) {
                const already = entries.some(v => v.name.trim().toLowerCase() === vName.toLowerCase());
                if (!already) entries.push({ name: vName, perc: '100%', att: '—', vid: level.vid || '', isVerifier: true });
            }
            return entries;
        }

        function renderPlayerTop() {
            const list = document.getElementById('playerTopList');
            if (!list) return;
            const lbl = currentLang === 'EN';

            const playerMap = {};
            const collect = (level) => {
                getLevelEntries(level).forEach(v => {
                    const name = v.name.trim();
                    if (!playerMap[name]) { playerMap[name] = { name, totalPoints: 0, completions: 0, records: 0, demons: [] }; }
                    const perc = parseInt((v.perc || '0').replace('%', ''));
                    if (perc < MIN_PERC) return;
                    playerMap[name].totalPoints += calcPts(perc, level.points);
                    if (perc >= 100) { playerMap[name].completions++; } else { playerMap[name].records++; }
                    playerMap[name].demons.push(level.name);
                });
            };
            demons.forEach(collect);
            challenges.forEach(collect);

            const allPlayers = Object.values(playerMap)
                .sort((a, b) => b.totalPoints - a.totalPoints)
                .filter(p => p.totalPoints > 0 || p.completions > 0);

            // Build country filter dropdown
            const usedCountries = [...new Set(
                allPlayers.map(p => playerCountries[p.name.toLowerCase()]).filter(Boolean)
            )].sort();
            const filterWrap = document.getElementById('countryFilterWrap');
            if (filterWrap) {
                if (usedCountries.length > 0) {
                    const opts = [`<option value="all">${lbl ? 'All countries' : 'Все страны'}</option>`]
                        .concat(usedCountries.map(c => `<option value="${c}">${countryFlag(c)} ${c}${countryFilter===c?' *':''}</option>`))
                        .join('');
                    filterWrap.innerHTML = `<select onchange="countryFilter=this.value;renderPlayerTop();" style="background:#0f1225;border:1px solid rgba(167,139,250,0.25);color:#e2d4f0;padding:8px 14px;border-radius:10px;font-family:'Nunito';font-size:0.85rem;cursor:pointer;outline:none;">
                        ${opts}
                    </select>`;
                    filterWrap.querySelector('select').value = countryFilter;
                } else {
                    filterWrap.innerHTML = '';
                }
            }

            // Apply filter
            const players = countryFilter === 'all'
                ? allPlayers
                : allPlayers.filter(p => (playerCountries[p.name.toLowerCase()] || '') === countryFilter);

            if (players.length === 0) {
                list.innerHTML = `<div class="player-top-empty">${lbl ? 'No players found.' : 'Рейтинг пуст.'}</div>`;
                return;
            }

            const medals = ['#1', '#2', '#3'];
            list.innerHTML = players.map((p, i) => {
                const rank = i + 1;
                const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-other';
                const rankDisplay = rank <= 3 ? medals[rank - 1] : `#${rank}`;
                const pts = p.totalPoints % 1 === 0 ? p.totalPoints : p.totalPoints.toFixed(2);
                const completionText = p.records > 0
                    ? `${p.completions} ${lbl?'compl.':'прохожд.'} · ${p.records} ${lbl?'rec.':'рекорд.'}`
                    : `${p.completions} ${lbl?'completions':'прохождений'}`;
                const flag = countryFlag(playerCountries[p.name.toLowerCase()]);

                let adminBtns = '';
                if (isAdmin) {
                    if (isEditMode) adminBtns += `<button class="ctrl-btn btn-edit" onclick="event.stopPropagation(); openEditSlayerModal('${p.name.replace(/'/g, "\\'")}')" style="margin-right:6px;"><i class="fas fa-pen"></i></button>`;
                    if (isDeleteMode) adminBtns += `<button class="ctrl-btn btn-del" onclick="event.stopPropagation(); deleteSlayer('${p.name.replace(/'/g, "\\'")}')"><i class="fas fa-trash"></i></button>`;
                }

                return `<div class="player-top-card" onclick="openPlayerProfile('${p.name.replace(/'/g, "\\'")}')">
                    <div class="player-top-rank ${rankClass}">${rankDisplay}</div>
                    <div class="player-top-avatar" style="font-size:1.3rem;">${flag || '&#127769;'}</div>
                    <div class="player-top-info">
                        <div class="player-top-name">${escapeHtml(p.name)}</div>
                        <div class="player-top-meta">${completionText}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        ${adminBtns !== '' ? `<div style="display:flex;">${adminBtns}</div>` : ''}
                        <div>
                            <div class="player-top-points">${pts}</div>
                            <span class="player-top-pts-label">pts</span>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }
        function deleteItem(k, p) {
            if (!isAdmin) { showToast('Нет доступа!'); return; }
            const allowed = ['demons', 'challenges', 'creators', 'reviews', 'players'];
            if (!allowed.includes(p)) { showToast('Недопустимый путь!'); return; }
            if (confirm("Подтверждаете удаление?")) db.ref(p + '/' + k).remove();
        }

        db.ref('players').on('value', snap => {
            playerCountries = {};
            if (snap.val()) {
                Object.entries(snap.val()).forEach(([nick, data]) => {
                    if (data && data.country) playerCountries[nick.toLowerCase()] = data.country;
                });
            }
            // Re-render tops if currently visible
            if (currentTab === 'players') renderPlayerTop();
            if (currentTab === 'creatortop') renderCreatorTop();
        });

        db.ref('maintenance').on('value', s => {
            const on = s.val() === true;
            const overlay = document.getElementById('maintenanceOverlay');
            if (on && !isModerator) { overlay.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
            else { overlay.style.display = 'none'; document.body.style.overflow = ''; }
        });



        // ===== PLAYER PROFILE =====
        function openPlayerProfile(playerName) {
            document.getElementById('detailModal').style.display = 'none';

            // Collect all entries for this player
            const allEntries = [];
            const collectProfile = (level) => {
                getLevelEntries(level).forEach(v => {
                    if (v.name.trim().toLowerCase() === playerName.toLowerCase()) {
                        allEntries.push({ demon: level, victor: v });
                    }
                });
            };
            demons.forEach(collectProfile);
            challenges.forEach(collectProfile);

            const getPerc = c => parseInt((c.victor.perc || '0').replace('%',''));
            const completions = allEntries.filter(c => getPerc(c) >= 100);
            const records     = allEntries.filter(c => { const p = getPerc(c); return p >= MIN_PERC && p < 100; });

            // Points: threshold 60%, curve ((perc-60)/40)^1.5 * ptsMax
            let totalPoints = 0;
            allEntries.forEach(c => {
                const perc = getPerc(c);
                if (perc < MIN_PERC) return;
                totalPoints += calcPts(perc, c.demon.points);
            });

            // Rank: find position in sorted leaderboard
            const playerMap = {};
            const collectAll = (level) => {
                getLevelEntries(level).forEach(v => {
                    const n = v.name.trim();
                    if (!playerMap[n]) playerMap[n] = { totalPoints: 0 };
                    const perc = parseInt((v.perc || '0').replace('%',''));
                    if (perc >= MIN_PERC) playerMap[n].totalPoints += calcPts(perc, level.points);
                });
            };
            demons.forEach(collectAll); challenges.forEach(collectAll);
            const sorted = Object.values(playerMap).sort((a, b) => b.totalPoints - a.totalPoints);
            const rank = sorted.findIndex(p => Math.abs(p.totalPoints - (playerMap[playerName] ? playerMap[playerName].totalPoints : -1)) < 0.001) + 1;

            // Hardest level = earliest position in the combined list among 100% completions
            let hardestEntry = null;
            if (completions.length > 0) {
                const withIdx = completions.map(c => {
                    const allList = [...demons, ...challenges];
                    return { c, idx: allList.indexOf(c.demon) };
                });
                withIdx.sort((a, b) => a.idx - b.idx);
                hardestEntry = withIdx[0].c;
            }

            // Verified levels (isVerifier flag)
            const verifiedEntries = completions.filter(c => c.victor.isVerifier);
            // Separate demons vs challenges completions (non-verified)
            const mainCompletions = completions.filter(c => !c.victor.isVerifier && demons.includes(c.demon));
            const challengeCompletions = completions.filter(c => !c.victor.isVerifier && challenges.includes(c.demon));

            // Fill header
            document.getElementById('profileName').textContent = playerName;
            document.getElementById('profilePoints').textContent = totalPoints < 0.01 ? '0' : totalPoints.toFixed(2);
            document.getElementById('profileRank').textContent = rank > 0 ? '#' + rank : '—';

            // Creator Points come strictly from the Creator Top entry with the same nickname.
            // If the player is not present in that top, the profile shows a dash.
            const creatorEntry = creators.find(c =>
                (c.name || '').trim().toLowerCase() === playerName.trim().toLowerCase()
            );
            const creatorPointsEl = document.getElementById('profileCreatorPoints');
            if (creatorPointsEl) {
                const cp = creatorEntry ? Number(creatorEntry.points) : NaN;
                creatorPointsEl.textContent = creatorEntry && Number.isFinite(cp)
                    ? (Number.isInteger(cp) ? String(cp) : cp.toFixed(2))
                    : '—';
            }
            const creatorPointsLabel = document.getElementById('labelCreatorPoints');
            if (creatorPointsLabel) {
                creatorPointsLabel.textContent = currentLang === 'EN' ? 'Creator Points' : 'Креатор поинты';
            }

            // Show country flag next to name
            const profileFlag = document.getElementById('profileFlag');
            if (profileFlag) {
                const flag = countryFlag(playerCountries[playerName.toLowerCase()]);
                profileFlag.textContent = flag;
                profileFlag.style.display = flag ? 'inline' : 'none';
            }

            // Hardest level
            const hardestWrap   = document.getElementById('profileHardestWrap');
            const hardestNameEl = document.getElementById('profileHardestName');
            const hardestBadge  = document.getElementById('profileHardestBadge');
            const hardestIcon   = document.getElementById('profileHardestIcon');
            if (hardestEntry) {
                const isChallengeHardest = challenges.includes(hardestEntry.demon);
                const isVerifiedHardest  = hardestEntry.victor.isVerifier;
                const listType = isChallengeHardest ? 'challenges' : 'demons';
                const ownList  = isChallengeHardest ? challenges : demons;
                const pos      = ownList.indexOf(hardestEntry.demon) + 1;

                hardestNameEl.innerHTML = `<span><span style="color:var(--accent);font-family:'Orbitron';font-size:0.8rem;margin-right:6px;">#${pos}</span>${escapeHtml(hardestEntry.demon.name)}</span>`;

                // Иконка, лейбл и бейджик по типу
                const labelEl = document.getElementById('labelHardest');
                hardestWrap.classList.remove('is-challenge', 'is-verified');
                if (isChallengeHardest) {
                    hardestIcon.innerHTML = '<i class="fas fa-bolt"></i>';
                    if (labelEl) labelEl.textContent = currentLang === 'EN' ? 'Hardest Challenge' : 'Сложнейший Челлендж';
                    if (isVerifiedHardest) {
                        // Верифицированный челлендж — синяя карточка + ЗЕЛЁНАЯ галочка "Verified"
                        hardestBadge.className = 'hardest-badge verified';
                        hardestBadge.innerHTML = '<i class="fas fa-check-circle"></i> Verified';
                    } else {
                        hardestBadge.className = 'hardest-badge challenge';
                        hardestBadge.innerHTML = '<i class="fas fa-bolt"></i> Challenge';
                    }
                    hardestBadge.style.display = 'inline-flex';
                    hardestWrap.classList.add('is-challenge');
                } else if (isVerifiedHardest) {
                    // Верифицированный демон — оранжевая карточка + зелёная галочка
                    hardestIcon.innerHTML = '<i class="fas fa-fire"></i>';
                    if (labelEl) labelEl.textContent = currentLang === 'EN' ? 'Hardest Level' : 'Сложнейший Демон';
                    hardestBadge.className = 'hardest-badge verified';
                    hardestBadge.innerHTML = '<i class="fas fa-check-circle"></i> Verified';
                    hardestBadge.style.display = 'inline-flex';
                } else {
                    hardestIcon.innerHTML = '<i class="fas fa-fire"></i>';
                    if (labelEl) labelEl.textContent = currentLang === 'EN' ? 'Hardest Level' : 'Сложнейший Демон';
                    hardestBadge.style.display = 'none';
                }

                hardestWrap.onclick = () => {
                    document.getElementById('playerProfileModal').style.display = 'none';
                    showInfoByKey(hardestEntry.demon.key, listType);
                };
                hardestWrap.style.display = 'block';
            } else {
                hardestWrap.onclick = null;
                hardestWrap.style.display = 'none';
                hardestBadge.style.display = 'none';
            }

            // Build sections
            const lbl = currentLang === 'EN';
            let sectionsHtml = '';

            // Main completions section
            if (mainCompletions.length > 0) {
                const pills = mainCompletions.map(c =>
                    `<span class="profile-pill" onclick="openPlayerVideo('${escapeHtml(playerName.replace(/'/g,"\\'"))}','${c.demon.key}','demons')" title="${escapeHtml(c.demon.name)}">${escapeHtml(c.demon.name)}</span>`
                ).join('');
                sectionsHtml += `<div class="profile-section-card">
                    <div class="profile-section-head">
                        <span class="profile-section-label"><i class="fas fa-star" style="color:#fbbf24;"></i> ${lbl ? 'Completions' : 'Прохождения'}</span>
                        <span class="profile-section-count">${mainCompletions.length}</span>
                    </div>
                    <div class="profile-pills">${pills}</div>
                </div>`;
            }

            // Challenges completions section
            if (challengeCompletions.length > 0) {
                const pills = challengeCompletions.map(c =>
                    `<span class="profile-pill" style="border-color:rgba(244,114,182,0.25);color:#f9a8d4;" onclick="openPlayerVideo('${escapeHtml(playerName.replace(/'/g,"\\'"))}','${c.demon.key}','challenges')" title="${escapeHtml(c.demon.name)}">${escapeHtml(c.demon.name)}</span>`
                ).join('');
                sectionsHtml += `<div class="profile-section-card" style="border-color:rgba(244,114,182,0.15);">
                    <div class="profile-section-head">
                        <span class="profile-section-label"><i class="fas fa-fire" style="color:#f472b6;"></i> ${lbl ? 'Challenges' : 'Челленджи'}</span>
                        <span class="profile-section-count">${challengeCompletions.length}</span>
                    </div>
                    <div class="profile-pills">${pills}</div>
                </div>`;
            }

            // Records section (partial %)
            if (records.length > 0) {
                const rows = records.map(c => {
                    const perc = c.victor.perc || '?%';
                    const att = c.victor.att ? `<span style="color:#4b5563;font-size:0.72rem;">${c.victor.att} att</span>` : '';
                    const vidLink = c.victor.vid
                        ? `<a href="https://youtube.com/watch?v=${c.victor.vid}" target="_blank" style="color:#f87171;font-size:0.78rem;"><i class="fab fa-youtube"></i></a>`
                        : '';
                    return `<div class="profile-record-row">
                        <span class="profile-record-name">${escapeHtml(c.demon.name)}</span>
                        <div class="profile-record-meta">
                            ${att}
                            <span class="profile-record-perc">${perc}</span>
                            ${vidLink}
                        </div>
                    </div>`;
                }).join('');
                sectionsHtml += `<div class="profile-section-card">
                    <div class="profile-section-head">
                        <span class="profile-section-label"><i class="fas fa-chart-line" style="color:#60a5fa;"></i> ${lbl ? 'Records' : 'Рекорды'}</span>
                        <span class="profile-section-count">${records.length}</span>
                    </div>
                    ${rows}
                </div>`;
            }

            // Verified section
            if (verifiedEntries.length > 0) {
                const pills = verifiedEntries.map(c =>
                    `<span class="profile-pill verified-pill" onclick="openPlayerVideo('${escapeHtml(playerName.replace(/'/g,"\\'"))}','${c.demon.key}','${challenges.includes(c.demon) ? 'challenges' : 'demons'}')" title="${escapeHtml(c.demon.name)}">${escapeHtml(c.demon.name)}</span>`
                ).join('');
                sectionsHtml += `<div class="profile-section-card verified">
                    <div class="profile-section-head">
                        <span class="profile-section-label" style="color:#4ade80;"><i class="fas fa-check-circle" style="color:#4ade80;"></i> ${lbl ? 'Which are verified' : 'Верифицированные'}</span>
                        <span class="profile-section-count">${verifiedEntries.length}</span>
                    </div>
                    <div class="profile-pills">${pills}</div>
                </div>`;
            }

            if (sectionsHtml === '') {
                sectionsHtml = `<p style="color:#4b5563;text-align:center;padding:20px 0;font-size:0.88rem;">${lbl ? 'No entries yet' : 'Записей пока нет'}</p>`;
            }

            document.getElementById('profileSections').innerHTML = sectionsHtml;
            document.getElementById('playerProfileModal').style.display = 'block';
            document.getElementById('playerProfileModal').scrollTop = 0;
        }

        // Opens the player's own YouTube video for a completed level.
        // If no video is stored, shows a red error toast instead.
        function openPlayerVideo(playerName, levelKey, listType) {
            const list = listType === 'challenges' ? challenges : demons;
            const level = list.find(d => d.key === levelKey);
            if (!level) return;

            // Find this player's entry for the level
            const entry = getLevelEntries(level).find(v => v.name.trim().toLowerCase() === playerName.toLowerCase());
            const vid = entry && entry.vid ? entry.vid.trim() : null;

            if (vid) {
                window.open('https://www.youtube.com/watch?v=' + vid, '_blank', 'noopener');
            } else {
                // Show red error toast
                const lbl = currentLang === 'EN';
                const toast = document.getElementById('copyToast');
                toast.innerHTML = '<i class="fas fa-times-circle" style="margin-right:8px;"></i>' +
                    (lbl ? 'Video not found' : 'Ссылка на прохождение не найдена');
                toast.className = 'show-error';
                setTimeout(() => { toast.className = ''; toast.innerHTML = ''; }, 3000);
            }
        }

        // ===== MOD QUICK PANEL FUNCTIONS =====
        function openModQuickPanel() {
            const sel = document.getElementById('modVicDemon');
            if (sel) sel.innerHTML = demons.map(d => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.name)}</option>`).join('');

            // Настраиваем форму добавления уровня по правам текущего модератора.
            const typeSel = document.getElementById('mLevelType');
            const addBox = document.getElementById('modAddLevelBox');
            if (typeSel) {
                const canDemons = isAdmin || !!currentUserPermissions.canAddDemons;
                const canChallenges = isAdmin || !!currentUserPermissions.canAddChallenges;
                const demonOpt = typeSel.querySelector('option[value="demons"]');
                const challengeOpt = typeSel.querySelector('option[value="challenges"]');

                if (demonOpt) demonOpt.disabled = !canDemons;
                if (challengeOpt) challengeOpt.disabled = !canChallenges;

                if (canDemons) typeSel.value = 'demons';
                else if (canChallenges) typeSel.value = 'challenges';

                if (addBox) addBox.style.display = (canDemons || canChallenges) ? 'block' : 'none';
                updateModLevelFormType();
            }

            document.getElementById('modQuickPanel').style.display = 'block';
        }

        function updateModLevelFormType() {
            const typeSel = document.getElementById('mLevelType');
            if (!typeSel) return;
            const isChal = typeSel.value === 'challenges';
            const title = document.getElementById('modLevelFormTitle');
            const btnText = document.getElementById('modAddLevelBtnText');
            const btn = document.getElementById('modAddLevelBtn');

            if (title) {
                title.textContent = isChal ? '🔥 Добавить челлендж' : '➕ Добавить демона';
                title.style.color = isChal ? '#fb923c' : 'var(--accent)';
            }
            if (btnText) btnText.textContent = isChal ? 'Добавить челлендж' : 'Добавить демона';
            if (btn) {
                btn.style.background = isChal
                    ? 'linear-gradient(135deg,#f97316,#f472b6)'
                    : 'linear-gradient(135deg,#7b5ea7,#3d85c8)';
            }
            populatePositionSelect('mPosition', isChal ? 'challenges' : 'demons');
        }

        function modToggleEditMode() {
            isEditMode = !isEditMode;
            if (isEditMode) isDeleteMode = false;
            const btn = document.getElementById('modEditBtnText');
            if (btn) btn.textContent = isEditMode ? 'Выключить редактирование' : 'Включить редактирование';
            const editBtn = document.getElementById('modEditBtn');
            if (editBtn) {
                editBtn.style.background = isEditMode ? 'rgba(243,156,18,0.25)' : 'rgba(243,156,18,0.1)';
                editBtn.style.borderColor = isEditMode ? 'rgba(243,156,18,0.6)' : 'rgba(243,156,18,0.3)';
            }
            render();
            showToast(isEditMode ? '✏️ Режим редактирования включён' : '✏️ Режим редактирования выключён');
            document.getElementById('modQuickPanel').style.display = 'none';
        }

        function showModVictorForm(type = 'demon') {
            const form = document.getElementById('modVictorForm');
            const sel = document.getElementById('modVicDemon');
            const typeInput = document.getElementById('modVicType');
            const title = document.getElementById('modVictorFormTitle');
            const isChal = type === 'challenge';
            if (typeInput) typeInput.value = type;
            if (title) {
                title.textContent = isChal ? 'Рекорд для челленджа' : 'Рекорд для демона';
                title.style.color = isChal ? '#fb923c' : 'var(--accent)';
            }
            if (sel) sel.innerHTML = (isChal ? challenges : demons).map(d => `<option value="${escapeHtml(d.key)}">${escapeHtml(d.name)}</option>`).join('');
            const isAlreadyOpen = form.style.display !== 'none';
            const isSameType = typeInput && typeInput.value === type;
            form.style.display = (isAlreadyOpen && isSameType) ? 'none' : 'block';
        }

        function modAddLevel() {
            if (!isModerator) { showToast('Нет доступа!'); return; }

            const type = document.getElementById('mLevelType')?.value || 'demons';
            const isChal = type === 'challenges';
            const allowed = isAdmin || (isChal
                ? !!currentUserPermissions.canAddChallenges
                : !!currentUserPermissions.canAddDemons);

            if (!allowed) {
                showToast(isChal
                    ? 'Нет прав на добавление челленджей'
                    : 'Нет прав на добавление демонов');
                return;
            }

            const name = document.getElementById('mName').value.trim();
            if (!name) { showToast('Введи название уровня!'); return; }

            const levelID = normalizeLevelID(document.getElementById('mID').value);
            const duplicate = findDuplicateLevelByID(levelID);
            if (duplicate) {
                showToast(duplicateLevelMessage(duplicate, levelID), 5500);
                return;
            }

            let r = document.getElementById('mVid').value.trim();
            let v = r.includes('v=') ? r.split('v=')[1].split('&')[0] : r.includes('youtu.be/') ? r.split('youtu.be/')[1].split('?')[0] : r;
            const targetList = isChal ? challenges : demons;
            const insertIndex = getInsertIndex('mPosition', targetList);

            addLevelAtPosition(type, {
                name,
                author: document.getElementById('mAuthor').value.trim(),
                levelID,
                tag: document.getElementById('mTag').value.trim(),
                verifier: document.getElementById('mVerifier').value.trim(),
                img: document.getElementById('mImg').value.trim(),
                vid: v,
                points: document.getElementById('mPoints').value.trim()
            }, insertIndex).then(() => {
                showToast(`${isChal ? '✅ Челлендж' : '✅ Демон'} добавлен на позицию #${insertIndex + 1}`);
                ['mName','mAuthor','mID','mTag','mVerifier','mImg','mVid','mPoints'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });
                populatePositionSelect('mPosition', type);
                document.getElementById('modQuickPanel').style.display = 'none';
            }).catch(e => showToast('Ошибка: ' + e.message));
        }

        function modAddVictor() {
            const dKey = document.getElementById('modVicDemon').value;
            const name = document.getElementById('modVicName').value.trim();
            const vicType = document.getElementById('modVicType').value || 'demon';
            if (!dKey) { showToast(vicType === 'challenge' ? 'Нет доступных челленджей' : 'Нет доступных демонов'); return; }
            if (!name) { showToast('Введи ник игрока!'); return; }
            const mVidRaw = document.getElementById('modVicVid').value.trim();
            let mVid = mVidRaw;
            if (mVidRaw.includes('v=')) mVid = mVidRaw.split('v=')[1].split('&')[0];
            else if (mVidRaw.includes('youtu.be/')) mVid = mVidRaw.split('youtu.be/')[1].split('?')[0];
            const basePath = vicType === 'challenge' ? 'challenges' : 'demons';
            db.ref(`${basePath}/${dKey}/victors`).push({
                name,
                perc: document.getElementById('modVicPerc').value.trim(),
                att: document.getElementById('modVicAtt').value.trim(),
                vid: mVid
            }).then(() => {
                showToast('Рекорд добавлен!');
                ['modVicName','modVicPerc','modVicAtt','modVicVid'].forEach(id => document.getElementById(id).value = '');
                document.getElementById('modVictorForm').style.display = 'none';
                document.getElementById('modQuickPanel').style.display = 'none';
            }).catch(e => showToast('Ошибка: ' + e.message));
        }

        // ===== MOD LOGIN PAGE =====
        function openModLoginPage() {
            document.getElementById('modLoginPage').style.display = 'flex';
            document.getElementById('modLoginEmail').value = '';
            document.getElementById('modLoginPass').value = '';
            document.getElementById('modLoginError').style.display = 'none';
            document.body.style.overflow = 'hidden';
            setTimeout(() => document.getElementById('modLoginEmail').focus(), 200);
        }

        function closeModLoginPage() {
            document.getElementById('modLoginPage').style.display = 'none';
            document.body.style.overflow = '';
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }

        function toggleModPassVis() {
            const inp = document.getElementById('modLoginPass');
            const icon = document.getElementById('modPassEyeIcon');
            if (inp.type === 'password') {
                inp.type = 'text';
                icon.className = 'fas fa-eye-slash';
            } else {
                inp.type = 'password';
                icon.className = 'fas fa-eye';
            }
        }

        async function doModLogin() {
            const email = document.getElementById('modLoginEmail').value.trim();
            const pass  = document.getElementById('modLoginPass').value;
            const errEl = document.getElementById('modLoginError');
            const btn   = document.getElementById('modLoginBtn');

            errEl.style.display = 'none';
            if (!email || !pass) {
                errEl.textContent = 'Введи email и пароль';
                errEl.style.display = 'block';
                return;
            }

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Входим...';

            try {
                const cred = await auth.signInWithEmailAndPassword(email, pass);
                // Проверяем, есть ли у аккаунта права модератора, ДО приветствия
                const modSnap = await db.ref('moderators/' + cred.user.uid).once('value');
                if (!modSnap.exists()) {
                    await auth.signOut();
                    errEl.textContent = 'У этого аккаунта нет прав модератора. Обратись к администратору.';
                    errEl.style.display = 'block';
                    return;
                }
                document.getElementById('modLoginPage').style.display = 'none';
                document.body.style.overflow = '';
                history.replaceState(null, '', window.location.pathname + window.location.search);
                showToast('✅ Добро пожаловать в команду!');
            } catch(e) {
                let msg = 'Неверный email или пароль';
                if (e.code === 'auth/too-many-requests') msg = 'Слишком много попыток. Подожди немного.';
                if (e.code === 'auth/user-disabled') msg = 'Аккаунт заблокирован.';
                if (e.code === 'auth/unauthorized-domain') {
                    msg = 'Этот домен не разрешён в Firebase Authentication. Добавь текущий домен в Authorized domains.';
                }
                errEl.textContent = msg;
                errEl.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> ВОЙТИ';
            }
        }

        function copyDemonLink() {
            const url = window.location.href;
            navigator.clipboard.writeText(url).then(() => {
                const btn = document.getElementById('shareDemonBtn');
                if (btn) {
                    btn.innerHTML = '<i class="fas fa-check"></i>';
                    btn.style.color = '#4ade80';
                    setTimeout(() => {
                        btn.innerHTML = '<i class="fas fa-link"></i>';
                        btn.style.color = '#60a5fa';
                    }, 2000);
                }
                showToast(currentLang === 'EN' ? 'Link copied!' : 'Ссылка скопирована!');
            });
        }

        // Hash routing — открывает карточку демона/челленджа при загрузке по прямой ссылке
        function checkHash() {
            const hash = window.location.hash;

            // Demon/Challenge deep link: #demon/KEY or #challenge/KEY
            const demonMatch = hash.match(/^#(demon|challenge)\/(.+)$/);
            if (demonMatch) {
                const type = demonMatch[1] === 'challenge' ? 'challenges' : 'demons';
                const key  = demonMatch[2];
                const list = type === 'demons' ? demons : challenges;
                if (list.find(x => x.key === key)) {
                    // Switch to correct section/tab first. Hash-link has priority over saved navigation state.
                    openSection('listSection', false);
                    if (currentTab !== (type === 'demons' ? 'demons' : 'challenges')) {
                        switchTab(type === 'demons' ? 'demons' : 'challenges', false);
                    }
                    showInfoByKey(key, type);
                } else {
                    // Data may not be loaded yet — wait for it
                    const unsubscribe = setInterval(() => {
                        const l = type === 'demons' ? demons : challenges;
                        if (l.find(x => x.key === key)) {
                            clearInterval(unsubscribe);
                            openSection('listSection', false);
                            if (currentTab !== (type === 'demons' ? 'demons' : 'challenges')) {
                                switchTab(type === 'demons' ? 'demons' : 'challenges', false);
                            }
                            showInfoByKey(key, type);
                        }
                    }, 300);
                    setTimeout(() => clearInterval(unsubscribe), 8000);
                }
                return;
            }

            // Закрытая страница входа для команды.
            // #mod-login оставлен для совместимости со старыми ссылками.
            if (hash === '#modloginpage' || hash === '#mod-login') {
                if (!isModerator) {
                    openModLoginPage();
                } else {
                    document.getElementById('modLoginPage').style.display = 'none';
                    document.body.style.overflow = '';
                    history.replaceState(null, '', window.location.pathname + window.location.search);
                    showToast('Ты уже вошёл как ' + (currentUserRole === 'admin' ? 'администратор' : 'модератор'));
                }
            }
        }

        window.addEventListener('hashchange', checkHash);
        window.addEventListener('load', checkHash);
        window.addEventListener('load', restoreNavigationState);
        if (window.location.hash) {
            setTimeout(checkHash, 400);
        }
        setTimeout(syncLevelViewModeUI, 0);
