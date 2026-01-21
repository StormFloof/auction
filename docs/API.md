# API Документация - Онлайн Аукцион

## Аутентификация

Система автоматически создает аккаунт при первом запросе и сохраняет `userId` в cookies.
При создании аккаунта автоматически начисляется **10,000 RUB**.

## Публичные API

### GET /api/auction/current

Получить информацию о текущем активном аукционе и топ-10 ставок.

**Ответ:**
```json
{
  "auction": {
    "id": "507f1f77bcf86cd799439011",
    "code": "MAIN_AUCTION",
    "title": "Аукцион на приз топ-5",
    "status": "active",
    "currency": "RUB",
    "lotsCount": 5,
    "currentRoundNo": 1,
    "roundEndsAt": "2026-01-21T20:00:00.000Z",
    "leaders": [
      {
        "participantId": "user_1234567890_abc123",
        "amount": "5000",
        "committedAt": "2026-01-21T19:30:00.000Z"
      }
    ]
  }
}
```

### POST /api/auction/bid

Разместить ставку в текущем аукционе.

**Body:**
```json
{
  "amount": 5000
}
```

**Ответ:**
```json
{
  "auctionId": "507f1f77bcf86cd799439011",
  "roundNo": 1,
  "participantId": "user_1234567890_abc123",
  "accepted": true,
  "amount": "5000",
  "roundEndsAt": "2026-01-21T20:00:00.000Z",
  "account": {
    "subjectId": "user_1234567890_abc123",
    "currency": "RUB",
    "total": "10000",
    "held": "5000",
    "available": "5000"
  }
}
```

### GET /api/auction/my-bids

Получить историю своих ставок (последние 50).

**Ответ:**
```json
{
  "bids": [
    {
      "auctionId": "507f1f77bcf86cd799439011",
      "roundNo": 1,
      "amount": "5000",
      "createdAt": "2026-01-21T19:30:00.000Z"
    }
  ]
}
```

## API для управления аккаунтом

### GET /api/auth/me

Получить информацию о текущем пользователе и балансе.

**Ответ:**
```json
{
  "userId": "user_1234567890_abc123",
  "account": {
    "subjectId": "user_1234567890_abc123",
    "currency": "RUB",
    "total": "10000",
    "held": "0",
    "available": "10000"
  }
}
```

### POST /api/auth/topup

Пополнить баланс (для тестирования).

**Body:**
```json
{
  "amount": 10000
}
```

**Ответ:**
```json
{
  "account": {
    "subjectId": "user_1234567890_abc123",
    "currency": "RUB",
    "total": "20000",
    "held": "0",
    "available": "20000"
  }
}
```

## Админ API (публичные)

### POST /api/admin/auction/create

Создать новый аукцион.

**Body:**
```json
{
  "code": "AUCTION_2",
  "title": "Второй аукцион",
  "lotsCount": 5,
  "roundDurationSec": 3600,
  "minIncrement": 100
}
```

**Ответ:**
```json
{
  "id": "507f1f77bcf86cd799439012",
  "code": "AUCTION_2",
  "title": "Второй аукцион",
  "status": "draft",
  "currency": "RUB",
  "lotsCount": 5
}
```

### POST /api/admin/auction/finish

Принудительно завершить текущий активный аукцион.

**Ответ:**
```json
{
  "auctionId": "507f1f77bcf86cd799439011",
  "winners": ["user_1234567890_abc123"],
  "winningBids": [
    {
      "participantId": "user_1234567890_abc123",
      "amount": "5000",
      "lotNo": 1
    }
  ],
  "finishedAt": "2026-01-21T19:45:00.000Z",
  "charged": [...],
  "released": [...]
}
```

### GET /api/admin/auction/stats

Получить статистику по аукционам.

**Ответ:**
```json
{
  "stats": {
    "activeAuctions": 1,
    "finishedAuctions": 5,
    "totalBids": 1234
  },
  "recentActive": [
    {
      "id": "507f1f77bcf86cd799439011",
      "code": "MAIN_AUCTION",
      "title": "Аукцион на приз топ-5",
      "currentRoundNo": 2,
      "roundEndsAt": "2026-01-21T20:00:00.000Z"
    }
  ]
}
```

## Worker (автоматический перезапуск)

Worker автоматически:
1. При старте проверяет наличие активного аукциона `MAIN_AUCTION`
2. Если нет - создает новый и запускает
3. Закрывает раунды по истечению времени
4. После завершения аукциона автоматически создает новый

**Настройки через переменные окружения:**
- `ROUND_DURATION_SEC` - длительность раунда (по умолчанию 3600 сек = 60 мин)
- `WORKER_INTERVAL_MS` - интервал проверки (по умолчанию 1000 мс)

## Ошибки

Все ошибки возвращаются в формате:
```json
{
  "statusCode": 400,
  "error": "BadRequest",
  "message": "описание ошибки",
  "details": {}
}
```

Коды ошибок:
- `401` - не авторизован
- `402` - недостаточно средств
- `404` - ресурс не найден
- `409` - конфликт (раунд закрыт, аукцион завершен)
- `422` - не выполнено правило минимального инкремента
- `500` - внутренняя ошибка сервера
