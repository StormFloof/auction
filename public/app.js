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
        try {
            const response = await fetch(`${API_BASE}${endpoint}`, {
                credentials: 'include'
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('API GET Error:', error);
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

// Display Update Functions
const updateUserDisplay = () => {
    const user = state.currentUser;
    if (!user) return;
    
    const balance = user.account?.available || user.balance || 0;
    $('username').textContent = escapeHtml(user.username || user.userId || 'Гость');
    $('profileUsername').textContent = escapeHtml(user.username || user.userId || 'Не установлен');
    $('profileBalance').textContent = `${escapeHtml(String(balance))} руб.`;
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
    
    // Показываем минимальную ставку если есть лидеры
    if (leaders.length > 0) {
        const topBid = parseInt(leaders[0].amount) || 0;
        // Предполагаем minIncrement = 100 (можно получить из конфига аукциона)
        const minIncrement = 100;
        const minBid = topBid + minIncrement;
        
        if (bidAmount > 0 && bidAmount < minBid) {
            warnings.push({
                type: 'warning',
                text: `⚠️ Минимальная ставка: ${minBid} руб. (${topBid} + ${minIncrement})`
            });
        }
    }
    
    // Отображаем предупреждения
    if (warningContainer) {
        if (warnings.length > 0) {
            warningContainer.innerHTML = warnings.map(w =>
                `<div style="padding: 8px 12px; margin-bottom: 8px; border-radius: 4px; font-size: 14px; ${
                    w.type === 'error'
                        ? 'background: rgba(255, 77, 79, 0.1); color: #ff4d4f; border: 1px solid rgba(255, 77, 79, 0.3);'
                        : 'background: rgba(250, 173, 20, 0.1); color: #faad14; border: 1px solid rgba(250, 173, 20, 0.3);'
                }">${w.text}</div>`
            ).join('');
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
    
    try {
        // Создаем аукцион
        const createResult = await api.post('/admin/auction/create', {
            code: code,
            title: title,
            lotsCount: lotsCount,
            minIncrement: minIncrement,
            roundDurationSec: duration * 60 // Convert to seconds
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

// SPA Routing
const routes = {
    '/': 'homePage',
    '/profile': 'profilePage',
    '/admin': 'adminPage'
};

const navigate = (path) => {
    // Hide all pages
    Object.values(routes).forEach(pageId => {
        const page = $(pageId);
        if (page) page.style.display = 'none';
    });
    
    // Show current page
    const pageId = routes[path] || routes['/'];
    const page = $(pageId);
    if (page) page.style.display = 'block';
    
    // Update active nav link
    $$('.nav-link').forEach(link => {
        link.classList.remove('active');
        if (link.getAttribute('data-route') === path) {
            link.classList.add('active');
        }
    });
    
    // Update URL without reload
    history.pushState({}, '', path);
    
    // Load page-specific data
    if (path === '/profile') {
        loadMyBids();
    } else if (path === '/admin') {
        loadStats();
    }
};

const initRouter = () => {
    // Handle navigation clicks
    $$('.nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const path = link.getAttribute('data-route');
            navigate(path);
        });
    });
    
    // Handle browser back/forward
    window.addEventListener('popstate', () => {
        navigate(location.pathname);
    });
    
    // Initial navigation
    navigate(location.pathname);
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
    
    // Setup button handlers
    $('placeBidBtn').addEventListener('click', handlePlaceBid);
    $('topupBtn').addEventListener('click', handleTopup);
    $('createAuctionBtn').addEventListener('click', handleCreateAuction);
    $('finishAuctionBtn').addEventListener('click', handleFinishAuction);
    
    // Initialize router
    initRouter();
    
    // Load initial data
    await loadUserData();
    await loadAuctionData();
    
    // Start polling
    startPolling();
    
    console.log('Frontend initialized successfully');
};

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
