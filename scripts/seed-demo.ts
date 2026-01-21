#!/usr/bin/env tsx
/**
 * Скрипт для создания демо-данных
 * Создает тестовые аккаунты, пополняет их балансы и создает демо-аукцион
 */

import 'dotenv/config';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000/api';

interface Account {
  participantId: string;
  displayName: string;
  depositAmount: string;
}

const DEMO_ACCOUNTS: Account[] = [
  { participantId: 'user1', displayName: 'Алексей', depositAmount: '50000' },
  { participantId: 'user2', displayName: 'Мария', depositAmount: '75000' },
  { participantId: 'user3', displayName: 'Дмитрий', depositAmount: '100000' },
  { participantId: 'user4', displayName: 'Елена', depositAmount: '60000' },
  { participantId: 'user5', displayName: 'Сергей', depositAmount: '80000' },
];

async function request(path: string, options: RequestInit = {}) {
  const url = `${API_BASE}${path}`;
  console.log(`→ ${options.method || 'GET'} ${url}`);
  
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json();
}

async function createDemoAccounts() {
  console.log('\n📝 Создание демо-аккаунтов...');
  
  for (const account of DEMO_ACCOUNTS) {
    try {
      await request(`/accounts/${account.participantId}/deposit`, {
        method: 'POST',
        body: JSON.stringify({
          amount: account.depositAmount,
          currency: 'RUB',
        }),
      });
      console.log(`✅ ${account.displayName} (${account.participantId}): ${account.depositAmount} RUB`);
    } catch (error: any) {
      console.log(`⚠️  ${account.displayName}: ${error.message}`);
    }
  }
}

async function createDemoAuction() {
  console.log('\n🎯 Создание демо-аукциона...');
  
  const auctionData = {
    code: 'DEMO-001',
    title: 'iPhone 16 Pro Max 🎁',
    currency: 'RUB',
    roundDurationSec: 60,
    minIncrement: '100',
    topK: 3,
    lotsCount: 1,
    snipingWindowSec: 15,
    extendBySec: 15,
    maxExtensionsPerRound: 5,
    autoParticipants: {
      enabled: true,
      strategy: 'calm',
      count: 15,
      tickMs: 2000,
    },
  };

  const auction = await request('/auctions', {
    method: 'POST',
    body: JSON.stringify(auctionData),
  });

  console.log(`✅ Аукцион создан: ${auction.code} (ID: ${auction._id})`);

  // Запускаем аукцион
  console.log('\n🚀 Запуск аукциона...');
  await request(`/auctions/${auction._id}/start`, {
    method: 'POST',
  });

  console.log('✅ Аукцион запущен!');
  console.log(`\n🌐 Откройте: http://localhost:3000/?auction=${auction._id}`);
  console.log(`📊 Dev Mode: http://localhost:3000/?auction=${auction._id}&dev=true\n`);

  return auction;
}

async function main() {
  console.log('🎬 Создание демо-данных для Contest Auction\n');
  console.log(`API: ${API_BASE}\n`);

  try {
    // Проверяем доступность API
    console.log('⏳ Проверка API...');
    await request('/health');
    console.log('✅ API доступен\n');

    await createDemoAccounts();
    await createDemoAuction();

    console.log('\n✨ Демо-данные успешно созданы!\n');
  } catch (error: any) {
    console.error('\n❌ Ошибка:', error.message);
    process.exit(1);
  }
}

main();
