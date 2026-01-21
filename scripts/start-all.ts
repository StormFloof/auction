#!/usr/bin/env tsx
/**
 * Скрипт для запуска всех компонентов системы
 * Запускает: API, Worker, Reconcile Worker
 */

import { spawn, type ChildProcess } from 'child_process';
import { resolve } from 'path';

interface Service {
  name: string;
  command: string;
  args: string[];
  color: string;
}

const SERVICES: Service[] = [
  {
    name: 'API',
    command: 'tsx',
    args: ['src/index.ts'],
    color: '\x1b[36m', // cyan
  },
  {
    name: 'WORKER',
    command: 'tsx',
    args: ['src/worker.ts'],
    color: '\x1b[33m', // yellow
  },
  {
    name: 'RECONCILE',
    command: 'tsx',
    args: ['src/worker-reconcile.ts'],
    color: '\x1b[35m', // magenta
  },
];

const RESET = '\x1b[0m';
const processes: ChildProcess[] = [];

function log(service: string, message: string, color: string) {
  const timestamp = new Date().toISOString().substring(11, 19);
  console.log(`${color}[${timestamp}] [${service}]${RESET} ${message}`);
}

function startService(service: Service): ChildProcess {
  log(service.name, `Запуск: ${service.command} ${service.args.join(' ')}`, service.color);

  const proc = spawn(service.command, service.args, {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  proc.stdout?.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line: string) => {
      if (line) log(service.name, line, service.color);
    });
  });

  proc.stderr?.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line: string) => {
      if (line) log(service.name, `ERROR: ${line}`, service.color);
    });
  });

  proc.on('exit', (code) => {
    log(service.name, `Завершен с кодом ${code}`, service.color);
  });

  return proc;
}

async function main() {
  console.log('\n🚀 Запуск Contest Auction Stack\n');

  // Запускаем все сервисы
  for (const service of SERVICES) {
    const proc = startService(service);
    processes.push(proc);
    // Небольшая задержка между запусками
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log('\n✅ Все сервисы запущены\n');
  console.log('📝 Для остановки нажмите Ctrl+C\n');

  // Обработка завершения
  const shutdown = () => {
    console.log('\n\n🛑 Остановка сервисов...\n');
    processes.forEach((proc) => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
      }
    });
    setTimeout(() => process.exit(0), 2000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('❌ Ошибка:', error);
  process.exit(1);
});
