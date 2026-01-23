// API Base URL
const API_BASE = '/api';

// State
const state = {
    currentUser: null,
    currentAuction: null,
    topBids: [],
    myBids: [],
    transactions: [],
    stats: null,
    wins: [],
    auctionHistory: [],
    historyPagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    pollingInterval: null,
    timerInterval: null
};

// Utility Functions
const $ = (id) => document.getElementById(id);
const $$ = (selector) => document.querySelectorAll(selector);

// XSS Protection Helper
const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
};

const formatTime = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString('ru-RU');
};

const showToast = (message, type = 'success') => {
    const toast = $('toast');
    const toastMessage = $('toastMessage');
    
    toast.className = 'toast show';
    if (type === 'error') toast.classList.add('error');
    if (type === 'warning') toast.classList.add('warning');
    
    toastMessage.textContent = message;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
};

// API Functions
const api = {
    async get(endpoint) {
        console.log('[DEBUG] API GET:', endpoint);
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                credentials: 'include',
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            console.log('[DEBUG] API GET Response:', {
                endpoint,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries())
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            console.log('[DEBUG] API GET Data:', { endpoint, data });
            return data;
        } catch (error) {
            console.error('[ERROR] API GET Error:', { endpoint, error });
            throw error;
        }
    },

    async post(endpoint, data) {
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `HTTP ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error('API POST Error:', error);
            throw error;
        }
    }
};

// Data Functions
const loadUserData = async () => {
    try {
        const data = await api.get('/auth/me');
        state.currentUser = data;
        updateUserDisplay();
    } catch (error) {
        console.error('Failed to load user data:', error);
    }
};

const loadAuctionData = async () => {
    try {
        const data = await api.get('/auction/current');
        state.currentAuction = data;
        
        if (data.bids && Array.isArray(data.bids)) {
            state.topBids = data.bids.slice(0, 5);
        }
        
        updateAuctionDisplay();
        updateTopBidsDisplay();
    } catch (error) {
        console.error('Failed to load auction data:', error);
    }
};

const loadMyBids = async () => {
    try {
        const data = await api.get('/auction/my-bids');
        state.myBids = data.bids || [];
        updateMyBidsDisplay();
    } catch (error) {
        console.error('Failed to load my bids:', error);
    }
};

const loadStats = async () => {
    try {
        const data = await api.get('/admin/auction/stats');
        state.stats = data;
        updateStatsDisplay();
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
};

const loadWins = async () => {
    try {
        const data = await api.get('/auction/my-wins');
        state.wins = data.wins || [];
        updateWinsDisplay();
    } catch (error) {
        console.error('Failed to load wins:', error);
    }
};

const loadAuctionHistory = async (page = 1) => {
    console.log('[DEBUG] loadAuctionHistory: начало загрузки истории', { page });
    
    // Показываем индикатор загрузки
    const container = $('historyList');
    if (container) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p>Загрузка...</p></div>';
    }
    
    try {
        const data = await api.get(`/auction/history?page=${page}&limit=20`);
        console.log('[DEBUG] loadAuctionHistory: получен ответ', {
            status: 'success',
            auctionsCount: data.auctions?.length || 0,
            pagination: { page: data.page, total: data.total, totalPages: data.totalPages }
        });
        
        state.auctionHistory = data.auctions || [];
        state.historyPagination = {
            page: data.page || 1,
            limit: data.limit || 20,
            total: data.total || 0,
            totalPages: data.totalPages || 0
        };
        
        renderHistory();
    } catch (error) {
        console.error('[ERROR] loadAuctionHistory: ошибка загрузки истории', error);
        if (container) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Ошибка загрузки истории</p></div>';
        }
    }
};

const loadAuctionDetails = async (auctionId) => {
    console.log('[DEBUG] loadAuctionDetails: загрузка деталей для ID', auctionId);
    try {
        const data = await api.get(`/auction/${auctionId}`);
        console.log('[DEBUG] loadAuctionDetails: получен ответ', {
            status: 'success',
            auctionId: data.auction?._id,
            data: data
        });
        showAuctionDetails(data.auction);
    } catch (error) {
        console.error('[ERROR] loadAuctionDetails: ошибка загрузки деталей', {
            auctionId,
            error
        });
        showToast('Не удалось загрузить детали аукциона', 'error');
    }
};

// Display Update Functions
const updateUserDisplay = () => {
    const user = state.currentUser;
    if (!user) return;
    
    const balance = user.account?.available || user.balance || 0;
    $('username').textContent = escapeHtml(user.username || user.userId || 'Гость');
    $('profileUsername').textContent = escapeHtml(user.username || user.userId || 'Не установлен');
    $('profileBalance').textContent = `${escapeHtml(String(balance))} руб.`;
    
    // Обновляем виджет баланса на главной
    updateBalanceWidget();
};

const updateBalanceWidget = () => {
    const user = state.currentUser;
    if (!user || !user.account) return;
    
    const available = Number(user.account.available) || 0;
    const held = Number(user.account.held) || 0;
    const total = available + held;
    
    const availableEl = $('balanceAvailable');
    const heldEl = $('balanceHeld');
    const totalEl = $('balanceTotal');
    
    if (availableEl) availableEl.textContent = `${available} ₽`;
    if (heldEl) heldEl.textContent = `${held} ₽`;
    if (totalEl) totalEl.textContent = `${total} ₽`;
};

const updateAuctionDisplay = () => {
    const auction = state.currentAuction;
    if (!auction || !auction.auction) return;
    
    const auctionData = auction.auction;
    
    // Prize title
    $('prizeTitle').textContent = escapeHtml(auctionData.title || 'Приз участникам топ-5');
    
    // Round number with winners info
    const lotsCount = auctionData.lotsCount || 5;
    const roundNumber = auctionData.currentRoundNo || 1;
    $('roundNumber').textContent = roundNumber;
    
    // Update round info with winners count
    const roundInfo = $('roundInfo');
    if (roundInfo) {
        roundInfo.textContent = `${lotsCount} победителей получат приз`;
    }
    
    // Status
    const status = auctionData.status || 'active';
    const statusIcon = $('statusIcon');
    const statusText = $('auctionStatus');
    
    if (status === 'active') {
        statusIcon.style.color = 'var(--success)';
        statusText.textContent = 'Активен';
    } else if (status === 'finished') {
        statusIcon.style.color = 'var(--danger)';
        statusText.textContent = 'Завершен';
    } else {
        statusIcon.style.color = 'var(--warning)';
        statusText.textContent = 'Ожидание';
    }
    
    // Timer
    updateTimer();
    
    // Обновляем валидацию формы ставки
    updateBidFormValidation();
};

const updateTimer = () => {
    const auction = state.currentAuction;
    if (!auction || !auction.auction || !auction.auction.roundEndsAt) {
        $('timer').textContent = '00:00:00';
        return;
    }
    
    const updateTimerDisplay = () => {
        const now = new Date().getTime();
        const end = new Date(auction.auction.roundEndsAt).getTime();
        const diff = Math.max(0, Math.floor((end - now) / 1000));
        
        $('timer').textContent = formatTime(diff);
        
        if (diff === 0) {
            clearInterval(state.timerInterval);
            loadAuctionData(); // Reload auction data when timer ends
        }
    };
    
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
    
    updateTimerDisplay();
    state.timerInterval = setInterval(updateTimerDisplay, 1000);
};

const updateTopBidsDisplay = () => {
    const container = $('topBids');
    const auction = state.currentAuction;
    const leaders = auction && auction.auction ? auction.auction.leaders : [];
    
    if (!leaders || leaders.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>Ставок пока нет</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = leaders.map((leader, index) => `
        <div class="bid-item rank-${index + 1}">
            <div class="bid-user">
                <div class="bid-rank">${index + 1}</div>
                <span>${escapeHtml(leader.participantId || `Участник ${index + 1}`)}</span>
            </div>
            <div class="bid-amount">${escapeHtml(String(leader.amount || 0))} руб.</div>
        </div>
    `).join('');
};

const updateMyBidsDisplay = () => {
    const tbody = $('bidsHistory');
    const bids = state.myBids;
    
    if (!bids || bids.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="4" class="empty-cell">
                    <i class="fas fa-inbox"></i>
                    История пуста
                </td>
            </tr>
        `;
        return;
    }
    
    tbody.innerHTML = bids.map(bid => `
        <tr>
            <td>${escapeHtml(String(bid.roundNo || '-'))}</td>
            <td>${escapeHtml(String(bid.amount || 0))} руб.</td>
            <td>${escapeHtml(formatDate(bid.createdAt))}</td>
            <td>
                <span class="status-badge status-placed">
                    Размещена
                </span>
            </td>
        </tr>
    `).join('');
};

const updateStatsDisplay = () => {
    const stats = state.stats;
    if (!stats || !stats.stats) return;
    
    const statData = stats.stats;
    $('statTotalBids').textContent = statData.totalBids || 0;
    $('statParticipants').textContent = statData.activeAuctions || 0;
    $('statTotalAmount').textContent = `${statData.totalBids || 0}`;
    $('statWinners').textContent = statData.finishedAuctions || 0;
};

const updateWinsDisplay = () => {
    const container = $('winsList');
    const wins = state.wins;
    
    if (!wins || wins.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>Пока нет побед</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = wins.map(win => `
        <div class="win-card">
            <h3>
                <i class="fas fa-gavel"></i>
                ${escapeHtml(win.auctionTitle)}
            </h3>
            <p><strong>Раунд:</strong> #${escapeHtml(String(win.roundNo))}</p>
            <p><strong>Ставка:</strong> ${escapeHtml(String(win.amount))} руб.</p>
            <p><strong>Дата победы:</strong> ${escapeHtml(formatDate(win.wonAt))}</p>
            <span class="badge ${win.captured ? 'captured' : 'pending'}">
                ${win.captured ? 'Выигрыш ✅' : 'Pending ⏳'}
            </span>
        </div>
    `).join('');
};

const renderHistory = () => {
    console.log('[DEBUG] renderHistory: отображение истории', {
        count: state.auctionHistory?.length || 0,
        pagination: state.historyPagination
    });
    const container = $('historyList');
    const history = state.auctionHistory;
    const pagination = state.historyPagination;
    
    if (!history || history.length === 0) {
        console.log('[DEBUG] renderHistory: история пуста, показываем empty state');
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>История аукционов пуста</p>
            </div>
        `;
        return;
    }
    
    const historyHtml = history.map(auction => `
        <div class="history-card" onclick="loadAuctionDetails('${escapeHtml(auction._id || auction.id)}')">
            <div class="history-card-header">
                <h3>
                    <i class="fas fa-gavel"></i>
                    ${escapeHtml(auction.title || 'Аукцион')}
                </h3>
                <span class="status-badge status-${auction.status}">
                    ${auction.status === 'finished' ? 'Завершен' : 'Активен'}
                </span>
            </div>
            <div class="history-card-body">
                <p><i class="fas fa-trophy"></i> <strong>Победителей:</strong> ${auction.winners ? auction.winners.length : 0}</p>
                <p><i class="fas fa-hashtag"></i> <strong>Раундов:</strong> ${escapeHtml(String(auction.currentRoundNo || 1))}</p>
                <p><i class="fas fa-clock"></i> <strong>Завершен:</strong> ${auction.endTime ? escapeHtml(formatDate(auction.endTime)) : 'Дата неизвестна'}</p>
            </div>
            <div class="history-card-footer">
                <button class="btn-link">
                    Подробнее <i class="fas fa-arrow-right"></i>
                </button>
            </div>
        </div>
    `).join('');
    
    // Добавляем пагинацию
    const hasPrev = pagination.page > 1;
    const hasNext = pagination.page < pagination.totalPages;
    
    const paginationHtml = `
        <div class="pagination">
            <button
                class="pagination-btn pagination-prev"
                ${!hasPrev ? 'disabled' : ''}
                onclick="loadAuctionHistory(${pagination.page - 1})"
            >
                <i class="fas fa-chevron-left"></i>
                Назад
            </button>
            <div class="pagination-info">
                Страница ${pagination.page} из ${pagination.totalPages}
                <span class="pagination-total">(всего: ${pagination.total})</span>
            </div>
            <button
                class="pagination-btn pagination-next"
                ${!hasNext ? 'disabled' : ''}
                onclick="loadAuctionHistory(${pagination.page + 1})"
            >
                Вперед
                <i class="fas fa-chevron-right"></i>
            </button>
        </div>
    `;
    
    container.innerHTML = historyHtml + paginationHtml;
};

const showAuctionDetails = (auction) => {
    console.log('[DEBUG] showAuctionDetails: отображение деталей', auction);
    const modal = $('auctionDetailsModal');
    const modalContent = $('auctionDetailsContent');
    
    const winners = auction.winners || [];
    const rounds = auction.rounds || [];
    
    // Правильный маппинг статусов
    const statusMap = {
        'finished': 'Завершен',
        'active': 'Активен',
        'draft': 'Черновик',
        'cancelled': 'Отменен'
    };
    const statusText = statusMap[auction.status] || 'Неизвестно';
    
    modalContent.innerHTML = `
        <div class="modal-header-details">
            <h2>
                <i class="fas fa-gavel"></i>
                ${escapeHtml(auction.title || 'Аукцион')}
            </h2>
            <span class="status-badge status-${auction.status}">
                ${statusText}
            </span>
        </div>
        
        <div class="modal-section">
            <h3><i class="fas fa-info-circle"></i> Основная информация</h3>
            <p><strong>Код:</strong> ${escapeHtml(auction.code || '-')}</p>
            <p><strong>Описание:</strong> ${escapeHtml(auction.description || 'Нет описания')}</p>
            <p><strong>Количество победителей:</strong> ${escapeHtml(String(auction.lotsCount || 5))}</p>
            <p><strong>Минимальный шаг:</strong> ${escapeHtml(String(auction.minIncrement || 100))} руб.</p>
        </div>
        
        <div class="modal-section">
            <h3><i class="fas fa-clock"></i> Временные рамки</h3>
            <p><strong>Начало:</strong> ${auction.startedAt ? escapeHtml(formatDate(auction.startedAt)) : '-'}</p>
            <p><strong>Окончание:</strong> ${auction.endTime ? escapeHtml(formatDate(auction.endTime)) : 'Дата неизвестна'}</p>
            <p><strong>Текущий раунд:</strong> #${escapeHtml(String(auction.currentRoundNo || 1))}</p>
        </div>
        
        ${winners.length > 0 ? `
        <div class="modal-section">
            <h3><i class="fas fa-trophy"></i> Победители</h3>
            <div class="winners-list">
                ${winners.map((winner, idx) => `
                    <div class="winner-item">
                        <span class="winner-rank">#${idx + 1}</span>
                        <span class="winner-name">${escapeHtml(winner.participantId || 'Участник')}</span>
                        <span class="winner-amount">${escapeHtml(String(winner.amount || 0))} руб.</span>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
        
        ${rounds.length > 0 ? `
        <div class="modal-section">
            <h3><i class="fas fa-list"></i> Раунды</h3>
            <div class="rounds-list">
                ${rounds.map((round, idx) => `
                    <div class="round-item">
                        <strong>Раунд #${idx + 1}</strong>
                        <p>Начало: ${round.startedAt ? escapeHtml(formatDate(round.startedAt)) : '-'}</p>
                        <p>Окончание: ${round.endedAt ? escapeHtml(formatDate(round.endedAt)) : 'В процессе'}</p>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
    `;
    
    modal.style.display = 'flex';
};

const closeAuctionDetailsModal = () => {
    const modal = $('auctionDetailsModal');
    modal.style.display = 'none';
};

const checkForWins = async () => {
    try {
        const user = state.currentUser;
        if (!user || !user.userId) return;
        
        const userId = user.userId;
        const shownWinsKey = 'shownWins_' + userId;
        const shownWins = JSON.parse(localStorage.getItem(shownWinsKey) || '[]');
        
        // Получаем историю аукционов
        const data = await api.get('/auction/history');
        const finishedAuctions = data.auctions || [];
        
        for (const auction of finishedAuctions) {
            if (auction.status !== 'finished') continue;
            if (!auction.winners || auction.winners.length === 0) continue;
            
            const auctionId = auction._id || auction.id;
            if (shownWins.includes(auctionId)) continue;
            
            // Проверяем, есть ли пользователь среди победителей
            const isWinner = auction.winners.some(w => w.participantId === userId);
            
            if (isWinner) {
                // Показываем поздравление
                showCongratulationsModal(auction);
                
                // Отмечаем как показанное
                shownWins.push(auctionId);
                localStorage.setItem(shownWinsKey, JSON.stringify(shownWins));
                
                // Показываем только одно поздравление за раз
                break;
            }
        }
    } catch (error) {
        console.error('Failed to check for wins:', error);
    }
};

const showCongratulationsModal = (auction) => {
    const modal = $('congratulationsModal');
    const modalContent = $('congratulationsContent');
    
    const user = state.currentUser;
    const userId = user?.userId;
    const winner = auction.winners?.find(w => w.participantId === userId);
    
    modalContent.innerHTML = `
        <div class="congrats-icon">
            <i class="fas fa-trophy"></i>
        </div>
        <h2>🎉 Поздравляем! 🎉</h2>
        <p class="congrats-message">
            Вы выиграли в аукционе<br>
            <strong>"${escapeHtml(auction.title || 'Аукцион')}"</strong>
        </p>
        <div class="congrats-details">
            <p><i class="fas fa-gavel"></i> Ваша ставка: <strong>${escapeHtml(String(winner?.amount || 0))} руб.</strong></p>
            <p><i class="fas fa-hashtag"></i> Раунд: <strong>#${escapeHtml(String(winner?.roundNo || 1))}</strong></p>
        </div>
    `;
    
    modal.style.display = 'flex';
};

const closeCongratulationsModal = () => {
    const modal = $('congratulationsModal');
    modal.style.display = 'none';
};

// Form Handlers
const handleBidInput = () => {
    const input = $('bidAmount');
    const slider = $('bidSlider');
    const display = $('bidAmountDisplay');
    
    input.addEventListener('input', () => {
        const value = parseInt(input.value) || 0;
        slider.value = value;
        display.textContent = value;
        updateBidFormValidation();
    });
    
    slider.addEventListener('input', () => {
        const value = parseInt(slider.value) || 0;
        input.value = value;
        display.textContent = value;
        updateBidFormValidation();
    });
};

// Валидация и предупреждения формы ставки
const updateBidFormValidation = () => {
    const placeBidBtn = $('placeBidBtn');
    const bidAmount = parseInt($('bidAmount').value) || 0;
    const user = state.currentUser;
    const auction = state.currentAuction?.auction;
    
    // Создаем контейнер для предупреждений если его нет
    let warningContainer = document.querySelector('.bid-warnings');
    if (!warningContainer) {
        const bidForm = document.querySelector('.bid-form');
        if (bidForm) {
            warningContainer = document.createElement('div');
            warningContainer.className = 'bid-warnings';
            warningContainer.style.marginTop = '10px';
            bidForm.insertBefore(warningContainer, placeBidBtn);
        }
    }
    
    const warnings = [];
    let canPlaceBid = true;
    
    // Проверка статуса аукциона
    if (!auction || auction.status !== 'active') {
        warnings.push({
            type: 'error',
            text: '⚠️ Аукцион не активен'
        });
        canPlaceBid = false;
    }
    
    // Получаем текущую ставку пользователя (если есть)
    const userId = user?.userId;
    const leaders = auction?.leaders || [];
    const myBid = leaders.find(l => l.participantId === userId);
    const currentBidAmount = myBid ? parseInt(myBid.amount) : 0;
    
    // Вычисляем дельту (доплату)
    const delta = Math.max(0, bidAmount - currentBidAmount);
    
    // Проверка баланса (требуется только delta, а не полная сумма!)
    const balance = user?.account?.available || 0;
    if (delta > balance) {
        warnings.push({
            type: 'error',
            text: `❌ Недостаточно средств. Нужно доплатить: ${delta} руб., доступно: ${balance} руб.`
        });
        canPlaceBid = false;
    } else if (balance < 100) {
        warnings.push({
            type: 'warning',
            text: `⚠️ Низкий баланс: ${balance} руб. Рекомендуем пополнить`
        });
    }
    
    // ИСПРАВЛЕНИЕ: Показываем минимум для победы (от лидера, не от своей ставки)
    if (leaders.length > 0) {
        const topBid = parseInt(leaders[0].amount) || 0;
        // БАГ #5 FIX: получаем minIncrement из API
        const minIncrement = auction?.minIncrement || 100;
        const minBid = topBid + minIncrement;
        
        // Всегда показываем минимум для победы как информацию
        warnings.push({
            type: 'info',
            text: `💰 Минимум для победы: ${minBid} руб. (лидер ${topBid} + increment ${minIncrement})`
        });
        
        if (bidAmount > 0 && bidAmount < minBid) {
            warnings.push({
                type: 'warning',
                text: `⚠️ Ваша ставка ${bidAmount} руб. меньше минимума для победы`
            });
        }
    }
    
    // Отображаем предупреждения
    if (warningContainer) {
        if (warnings.length > 0) {
            warningContainer.innerHTML = warnings.map(w => {
                let style = '';
                if (w.type === 'error') {
                    style = 'background: rgba(255, 77, 79, 0.1); color: #ff4d4f; border: 1px solid rgba(255, 77, 79, 0.3);';
                } else if (w.type === 'warning') {
                    style = 'background: rgba(250, 173, 20, 0.1); color: #faad14; border: 1px solid rgba(250, 173, 20, 0.3);';
                } else if (w.type === 'info') {
                    style = 'background: rgba(24, 144, 255, 0.1); color: #1890ff; border: 1px solid rgba(24, 144, 255, 0.3);';
                }
                return `<div style="padding: 8px 12px; margin-bottom: 8px; border-radius: 4px; font-size: 14px; ${style}">${w.text}</div>`;
            }).join('');
            warningContainer.style.display = 'block';
        } else {
            warningContainer.style.display = 'none';
        }
    }
    
    // Управляем кнопкой
    if (placeBidBtn) {
        placeBidBtn.disabled = !canPlaceBid || bidAmount <= 0;
        placeBidBtn.style.opacity = (!canPlaceBid || bidAmount <= 0) ? '0.5' : '1';
        placeBidBtn.style.cursor = (!canPlaceBid || bidAmount <= 0) ? 'not-allowed' : 'pointer';
    }
};

const handleQuickButtons = () => {
    $$('.quick-buttons .btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const amount = parseInt(btn.dataset.amount);
            const input = $('bidAmount');
            const currentValue = parseInt(input.value) || 0;
            input.value = currentValue + amount;
            input.dispatchEvent(new Event('input'));
        });
    });
};

const handlePlaceBid = async () => {
    const amount = parseInt($('bidAmount').value);
    
    if (!amount || amount <= 0) {
        showToast('Введите корректную сумму ставки', 'error');
        return;
    }
    
    // Проверка баланса перед отправкой (delta-based)
    const user = state.currentUser;
    const balance = user?.account?.available || 0;
    const auction = state.currentAuction?.auction;
    
    // Получаем текущую ставку пользователя
    const userId = user?.userId;
    const leaders = auction?.leaders || [];
    const myBid = leaders.find(l => l.participantId === userId);
    const currentBidAmount = myBid ? parseInt(myBid.amount) : 0;
    const delta = Math.max(0, amount - currentBidAmount);
    
    if (delta > balance) {
        showToast(`Недостаточно средств. Нужно доплатить: ${delta} руб., доступно: ${balance} руб. Пополните баланс`, 'error');
        // Переключаемся на профиль для пополнения
        setTimeout(() => navigate('/profile'), 2000);
        return;
    }
    
    // Проверка активности аукциона
    if (!auction || auction.status !== 'active') {
        showToast('Аукцион завершен, размещение ставок невозможно', 'error');
        return;
    }
    
    try {
        await api.post('/auction/bid', { amount });
        showToast('Ставка успешно размещена!');
        $('bidAmount').value = '';
        $('bidSlider').value = 0;
        $('bidAmountDisplay').textContent = 0;
        await loadAuctionData();
        await loadUserData();
        updateBalanceWidget(); // Обновляем баланс сразу
    } catch (error) {
        // Детальная обработка ошибок с учетом сообщений от сервера
        const errorMessage = error.message || 'Ошибка при размещении ставки';
        
        // Если ошибка про баланс - предлагаем пополнить
        if (errorMessage.includes('баланс') || errorMessage.includes('средств')) {
            showToast(errorMessage + '. Пополните баланс в профиле', 'error');
            setTimeout(() => navigate('/profile'), 2000);
        } else if (errorMessage.includes('элиминирован') || errorMessage.includes('элиминирован')) {
            showToast(errorMessage, 'warning');
        } else if (errorMessage.includes('завершен') || errorMessage.includes('закрыт')) {
            showToast(errorMessage, 'warning');
            await loadAuctionData();
        } else if (errorMessage.includes('больше') || errorMessage.includes('Минимальная')) {
            showToast(errorMessage, 'warning');
        } else {
            showToast(errorMessage, 'error');
        }
    }
};

const handleTopup = async () => {
    const amount = parseInt($('topupAmount').value);
    
    if (!amount || amount <= 0) {
        showToast('Введите корректную сумму пополнения', 'error');
        return;
    }
    
    try {
        const result = await api.post('/auth/topup', { amount });
        showToast('Баланс успешно пополнен!');
        $('topupAmount').value = '';
        
        // Обновляем баланс из ответа
        if (result.account && state.currentUser) {
            state.currentUser.account = result.account;
            updateUserDisplay();
        }
        
        // Перезагружаем данные для синхронизации
        await loadUserData();
    } catch (error) {
        showToast(error.message || 'Ошибка при пополнении баланса', 'error');
    }
};

const handleCreateAuction = async () => {
    const code = $('auctionCode').value.trim();
    const title = $('auctionTitle').value.trim();
    const lotsCount = parseInt($('lotsCount').value);
    const minIncrement = parseInt($('minIncrement').value);
    const duration = parseInt($('auctionDuration').value);
    const maxRounds = parseInt($('maxRounds').value);
    const snipingWindow = parseInt($('snipingWindow').value);
    const extendBy = parseInt($('extendBy').value);
    const maxExtensions = parseInt($('maxExtensions').value);
    
    if (!code) {
        showToast('Введите код аукциона', 'error');
        return;
    }
    
    if (!title) {
        showToast('Введите название аукциона', 'error');
        return;
    }
    
    if (!lotsCount || lotsCount <= 0) {
        showToast('Введите корректное количество лотов', 'error');
        return;
    }
    
    if (!minIncrement || minIncrement <= 0) {
        showToast('Введите корректный минимальный шаг ставки', 'error');
        return;
    }
    
    if (!duration || duration <= 0) {
        showToast('Введите корректную длительность', 'error');
        return;
    }
    
    if (!maxRounds || maxRounds <= 0 || maxRounds > 10) {
        showToast('Введите корректное количество раундов (1-10)', 'error');
        return;
    }
    
    if (isNaN(snipingWindow) || snipingWindow < 0 || snipingWindow > 300) {
        showToast('Окно снайпинга должно быть от 0 до 300 секунд', 'error');
        return;
    }
    
    if (isNaN(extendBy) || extendBy < 0 || extendBy > 300) {
        showToast('Продление раунда должно быть от 0 до 300 секунд', 'error');
        return;
    }
    
    if (isNaN(maxExtensions) || maxExtensions < 0 || maxExtensions > 100) {
        showToast('Лимит продлений должен быть от 0 до 100', 'error');
        return;
    }
    
    try {
        // Создаем аукцион
        const createResult = await api.post('/admin/auction/create', {
            code: code,
            title: title,
            lotsCount: lotsCount,
            minIncrement: minIncrement,
            roundDurationSec: duration * 60, // Convert to seconds
            maxRounds: maxRounds,
            snipingWindowSec: snipingWindow,
            extendBySec: extendBy,
            maxExtensionsPerRound: maxExtensions
        });
        
        // Стартуем аукцион автоматически
        if (createResult && createResult.id) {
            await api.post(`/auctions/${createResult.id}/start`, {});
            showToast('Аукцион создан и запущен!');
        } else {
            showToast('Аукцион создан!');
        }
        
        // Очистить поля формы
        $('auctionCode').value = '';
        $('auctionTitle').value = '';
        $('lotsCount').value = '5';
        $('minIncrement').value = '100';
        $('auctionDuration').value = '5';
        $('maxRounds').value = '5';
        $('snipingWindow').value = '60';
        $('extendBy').value = '30';
        $('maxExtensions').value = '10';
        
        await loadAuctionData();
    } catch (error) {
        showToast(error.message || 'Ошибка при создании аукциона', 'error');
    }
};

const handleFinishAuction = async () => {
    if (!confirm('Вы уверены, что хотите завершить аукцион?')) {
        return;
    }
    
    try {
        await api.post('/admin/auction/finish', {});
        showToast('Аукцион завершен!');
        await loadAuctionData();
        await loadStats();
    } catch (error) {
        showToast(error.message || 'Ошибка при завершении аукциона', 'error');
    }
};

const startAuction = async (auctionId) => {
    if (!confirm('Вы уверены, что хотите запустить аукцион?')) {
        return;
    }
    
    try {
        await api.post(`/auctions/${auctionId}/start`, {});
        showToast('Аукцион запущен!');
        await loadAuctionData();
        await loadStats();
    } catch (error) {
        showToast(error.message || 'Ошибка при запуске аукциона', 'error');
    }
};

const closeRoundWithResults = async (auctionId) => {
    if (!confirm('Вы уверены, что хотите закрыть раунд с результатами? Будут определены победители и выданы призы.')) {
        return;
    }
    
    try {
        await api.post(`/auctions/${auctionId}/rounds/close`, {});
        showToast('Раунд закрыт с результатами!');
        await loadAuctionData();
        await loadStats();
    } catch (error) {
        showToast(error.message || 'Ошибка при закрытии раунда', 'error');
    }
};

const skipRoundWithRefund = async (auctionId) => {
    if (!confirm('Вы уверены, что хотите пропустить раунд с возвратом ставок? Деньги будут возвращены всем участникам, победители не будут определены.')) {
        return;
    }
    
    try {
        await api.post(`/auctions/${auctionId}/rounds/skip`, {});
        showToast('Раунд пропущен, ставки возвращены!');
        await loadAuctionData();
        await loadStats();
    } catch (error) {
        showToast(error.message || 'Ошибка при пропуске раунда', 'error');
    }
};

const cancelAuction = async (auctionId) => {
    if (!confirm('Вы уверены, что хотите отменить аукцион? Это действие необратимо!')) {
        return;
    }
    
    try {
        await api.post(`/auctions/${auctionId}/cancel`, {});
        showToast('Аукцион отменен!');
        await loadAuctionData();
        await loadStats();
    } catch (error) {
        showToast(error.message || 'Ошибка при отмене аукциона', 'error');
    }
};

const renderAdminPage = () => {
    const auction = state.currentAuction?.auction;
    if (!auction) return;
    
    const auctionId = auction._id || auction.id;
    const status = auction.status || 'draft';
    const currentRound = auction.currentRoundNo || 1;
    const leaders = auction.leaders || [];
    const activeParticipants = leaders.length;
    
    // Кнопки управления
    const controlButtons = document.querySelector('#adminControlButtons');
    if (!controlButtons) return;
    
    let buttonsHtml = '';
    
    // Запустить аукцион
    if (status === 'draft') {
        buttonsHtml += `
            <button class="btn btn-success btn-large" onclick="startAuction('${auctionId}')">
                <i class="fas fa-play"></i>
                Запустить аукцион
            </button>
        `;
    }
    
    // Кнопки управления раундом
    if (status === 'active') {
        buttonsHtml += `
            <button class="btn btn-success btn-large" id="closeRoundWithResultsBtn" data-auction-id="${auctionId}">
                <i class="fas fa-check-circle"></i>
                Закрыть раунд с результатами
            </button>
            <button class="btn btn-warning btn-large" id="skipRoundWithRefundBtn" data-auction-id="${auctionId}">
                <i class="fas fa-undo"></i>
                Пропустить раунд с возвратом ставок
            </button>
        `;
    }
    
    // Отменить аукцион
    if (status === 'draft' || status === 'active') {
        buttonsHtml += `
            <button class="btn btn-danger btn-large" id="cancelAuctionBtn" data-auction-id="${auctionId}">
                <i class="fas fa-ban"></i>
                Отменить аукцион
            </button>
        `;
    }
    
    // Завершить текущий аукцион
    buttonsHtml += `
        <button class="btn btn-danger btn-large" id="finishAuctionBtn">
            <i class="fas fa-stop"></i>
            Завершить текущий аукцион
        </button>
    `;
    
    controlButtons.innerHTML = buttonsHtml;
    
    // Переназначаем обработчики для кнопок
    const finishBtn = document.getElementById('finishAuctionBtn');
    if (finishBtn) {
        finishBtn.addEventListener('click', handleFinishAuction);
    }
    
    const cancelBtn = document.getElementById('cancelAuctionBtn');
    if (cancelBtn) {
        const aId = cancelBtn.getAttribute('data-auction-id');
        cancelBtn.addEventListener('click', () => cancelAuction(aId));
    }
    
    const closeRoundBtn = document.getElementById('closeRoundWithResultsBtn');
    if (closeRoundBtn) {
        const aId = closeRoundBtn.getAttribute('data-auction-id');
        closeRoundBtn.addEventListener('click', () => closeRoundWithResults(aId));
    }
    
    const skipRoundBtn = document.getElementById('skipRoundWithRefundBtn');
    if (skipRoundBtn) {
        const aId = skipRoundBtn.getAttribute('data-auction-id');
        skipRoundBtn.addEventListener('click', () => skipRoundWithRefund(aId));
    }
    
    // Индикаторы аукциона
    const auctionIndicators = document.querySelector('#auctionIndicators');
    if (!auctionIndicators) return;
    
    let indicatorsHtml = `
        <div class="admin-indicator">
            <i class="fas fa-info-circle"></i>
            <div>
                <div class="indicator-label">Статус аукциона</div>
                <div class="indicator-value status-${status}">${statusMap[status] || 'Неизвестно'}</div>
            </div>
        </div>
        <div class="admin-indicator">
            <i class="fas fa-hashtag"></i>
            <div>
                <div class="indicator-label">Текущий раунд</div>
                <div class="indicator-value">#${currentRound}</div>
            </div>
        </div>
        <div class="admin-indicator">
            <i class="fas fa-users"></i>
            <div>
                <div class="indicator-label">Активных участников</div>
                <div class="indicator-value">${activeParticipants}</div>
            </div>
        </div>
    `;
    
    // Время до окончания раунда (если active)
    if (status === 'active' && auction.roundEndsAt) {
        const now = new Date().getTime();
        const end = new Date(auction.roundEndsAt).getTime();
        const diff = Math.max(0, Math.floor((end - now) / 1000));
        
        indicatorsHtml += `
            <div class="admin-indicator">
                <i class="fas fa-clock"></i>
                <div>
                    <div class="indicator-label">До конца раунда</div>
                    <div class="indicator-value">${formatTime(diff)}</div>
                </div>
            </div>
        `;
    }
    
    auctionIndicators.innerHTML = indicatorsHtml;
};

const statusMap = {
    'finished': 'Завершен',
    'active': 'Активен',
    'draft': 'Черновик',
    'cancelled': 'Отменен'
};

// SPA Routing
const routes = {
    '/': 'homePage',
    '/wins': 'winsPage',
    '/history': 'historyPage',
    '/profile': 'profilePage',
    '/admin': 'adminPage'
};

const navigate = (path) => {
    console.log('[NAVIGATE] Начало навигации:', {
        requestedPath: path,
        currentPath: location.pathname,
        availableRoutes: Object.keys(routes)
    });
    
    // Hide all pages
    Object.values(routes).forEach(pageId => {
        const page = $(pageId);
        if (page) {
            page.style.display = 'none';
            console.log('[NAVIGATE] Скрыта страница:', pageId);
        } else {
            console.warn('[NAVIGATE] Страница не найдена:', pageId);
        }
    });
    
    // Show current page
    const pageId = routes[path] || routes['/'];
    console.log('[NAVIGATE] Определен pageId:', {
        path: path,
        resolvedPageId: pageId,
        fallbackUsed: !routes[path]
    });
    
    const page = $(pageId);
    if (page) {
        page.style.display = 'block';
        console.log('[NAVIGATE] ✅ Показана страница:', pageId);
    } else {
        console.error('[NAVIGATE] ❌ Элемент страницы не найден:', pageId);
    }
    
    // Update active nav link
    let activeLinksCount = 0;
    $$('.nav-link').forEach(link => {
        link.classList.remove('active');
        const linkRoute = link.getAttribute('data-route');
        if (linkRoute === path) {
            link.classList.add('active');
            activeLinksCount++;
            console.log('[NAVIGATE] Активирована ссылка:', linkRoute);
        }
    });
    console.log('[NAVIGATE] Обновлено навигационных ссылок:', activeLinksCount);
    
    // Update URL without reload
    history.pushState({}, '', path);
    console.log('[NAVIGATE] URL обновлен:', path);
    
    // Load page-specific data
    if (path === '/profile') {
        console.log('[NAVIGATE] Загрузка данных профиля');
        loadMyBids();
    } else if (path === '/admin') {
        console.log('[NAVIGATE] Загрузка данных админки');
        loadStats();
        renderAdminPage();
    } else if (path === '/wins') {
        console.log('[NAVIGATE] Загрузка выигрышей');
        loadWins();
    } else if (path === '/history') {
        console.log('[NAVIGATE] Загрузка истории аукционов');
        loadAuctionHistory();
    } else {
        console.log('[NAVIGATE] Главная страница, дополнительные данные не требуются');
    }
    
    console.log('[NAVIGATE] ===== Навигация завершена =====');
};

const initRouter = () => {
    console.log('[ROUTER] Инициализация роутера');
    
    // Handle navigation clicks
    const navLinks = $$('.nav-link');
    console.log('[ROUTER] Найдено навигационных ссылок:', navLinks.length);
    
    navLinks.forEach((link, index) => {
        const route = link.getAttribute('data-route');
        console.log(`[ROUTER] Регистрация обработчика клика для ссылки #${index}:`, {
            href: link.getAttribute('href'),
            route: route,
            text: link.textContent.trim()
        });
        
        link.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('[ROUTER] 🖱️ Клик по навигационной ссылке:', route);
            navigate(route);
        });
    });
    
    // Handle browser back/forward
    window.addEventListener('popstate', () => {
        console.log('[ROUTER] ⬅️ Событие popstate (назад/вперед):', location.pathname);
        navigate(location.pathname);
    });
    
    // Initial navigation
    console.log('[ROUTER] Начальная навигация к:', location.pathname);
    navigate(location.pathname);
    
    console.log('[ROUTER] ✅ Роутер инициализирован');
};

// Polling
const startPolling = () => {
    // Clear existing interval
    if (state.pollingInterval) {
        clearInterval(state.pollingInterval);
    }
    
    // Poll every 3 seconds
    state.pollingInterval = setInterval(async () => {
        await loadAuctionData();
        await loadUserData();
        await checkForWins();
        
        // Update admin page if visible
        const adminPage = $('adminPage');
        if (adminPage && adminPage.style.display !== 'none') {
            renderAdminPage();
        }
    }, 3000);
};

const stopPolling = () => {
    if (state.pollingInterval) {
        clearInterval(state.pollingInterval);
        state.pollingInterval = null;
    }
    if (state.timerInterval) {
        clearInterval(state.timerInterval);
        state.timerInterval = null;
    }
};

// Initialize
const init = async () => {
    console.log('Initializing auction frontend...');
    
    // Setup form handlers
    handleBidInput();
    handleQuickButtons();
    
    // Setup button handlers с проверкой на существование
    const placeBidBtn = $('placeBidBtn');
    if (placeBidBtn) {
        placeBidBtn.addEventListener('click', handlePlaceBid);
        console.log('[INIT] ✅ Обработчик для placeBidBtn добавлен');
    }
    
    const topupBtn = $('topupBtn');
    if (topupBtn) {
        topupBtn.addEventListener('click', handleTopup);
        console.log('[INIT] ✅ Обработчик для topupBtn добавлен');
    }
    
    const createAuctionBtn = $('createAuctionBtn');
    if (createAuctionBtn) {
        createAuctionBtn.addEventListener('click', handleCreateAuction);
        console.log('[INIT] ✅ Обработчик для createAuctionBtn добавлен');
    }
    
    // finishAuctionBtn создается динамически в renderAdminPage(), не добавляем здесь
    // обработчик назначается там же (строка 1032-1035)
    
    const quickTopupBtn = $('quickTopupBtn');
    if (quickTopupBtn) {
        quickTopupBtn.addEventListener('click', () => navigate('/profile'));
        console.log('[INIT] ✅ Обработчик для quickTopupBtn добавлен');
    }
    
    // Initialize router
    initRouter();
    
    // Load initial data
    await loadUserData();
    await loadAuctionData();
    
    // Check for wins on initial load
    await checkForWins();
    
    // Start polling
    startPolling();
    
    // Setup modal close handlers
    const detailsModal = $('auctionDetailsModal');
    const congratsModal = $('congratulationsModal');
    
    if (detailsModal) {
        detailsModal.addEventListener('click', (e) => {
            if (e.target === detailsModal) closeAuctionDetailsModal();
        });
        
        const closeBtn = detailsModal.querySelector('.modal-close');
        if (closeBtn) closeBtn.addEventListener('click', closeAuctionDetailsModal);
    }
    
    if (congratsModal) {
        const closeBtn = congratsModal.querySelector('.congrats-close-btn');
        if (closeBtn) closeBtn.addEventListener('click', closeCongratulationsModal);
    }
    
    console.log('Frontend initialized successfully');
};

// Make functions globally accessible for onclick handlers
window.startAuction = startAuction;
window.closeRoundWithResults = closeRoundWithResults;
window.skipRoundWithRefund = skipRoundWithRefund;
window.cancelAuction = cancelAuction;
window.loadAuctionDetails = loadAuctionDetails;
window.closeAuctionDetailsModal = closeAuctionDetailsModal;
window.loadAuctionHistory = loadAuctionHistory;

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    stopPolling();
});

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
