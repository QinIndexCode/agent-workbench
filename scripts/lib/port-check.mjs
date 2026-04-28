import net from 'node:net';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

export const DEFAULT_SERVICE_PORTS = {
  backend: 3011,
  frontend: 5173
};

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true
  });
}

async function isTcpPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finalize = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(400);
    socket.once('connect', () => finalize(true));
    socket.once('timeout', () => finalize(false));
    socket.once('error', () => finalize(false));
    socket.connect(port, '127.0.0.1');
  });
}

function getWindowsPortOccupant(port) {
  const netstat = run('cmd.exe', ['/d', '/s', '/c', 'netstat', '-ano', '-p', 'tcp']);
  if ((netstat.status ?? 1) !== 0) {
    return null;
  }
  const lines = (netstat.stdout ?? '').split(/\r?\n/);
  const match = lines.find((line) => line.includes(`:${port}`) && line.toUpperCase().includes('LISTENING'));
  if (!match) {
    return null;
  }
  const parts = match.trim().split(/\s+/);
  const pid = parts.at(-1) ?? null;
  if (!pid) {
    return null;
  }
  const tasklist = run('cmd.exe', ['/d', '/s', '/c', 'tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const taskLine = (tasklist.stdout ?? '').trim().split(/\r?\n/)[0] ?? '';
  const processName = taskLine.startsWith('"')
    ? taskLine.split('","')[0]?.replace(/^"/, '') ?? null
    : null;
  return {
    pid,
    processName
  };
}

function getPosixPortOccupant(port) {
  const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if ((lsof.status ?? 1) !== 0) {
    return null;
  }
  const lines = (lsof.stdout ?? '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return null;
  }
  const parts = lines[1].trim().split(/\s+/);
  return {
    pid: parts[1] ?? null,
    processName: parts[0] ?? null
  };
}

export async function getPortStatus(port, service) {
  const occupied = await isTcpPortOpen(port);
  const occupant = occupied
    ? (process.platform === 'win32' ? getWindowsPortOccupant(port) : getPosixPortOccupant(port))
    : null;
  return {
    service,
    port,
    occupied,
    occupant
  };
}

export async function ensurePortsFree(entries) {
  const statuses = [];
  for (const entry of entries) {
    statuses.push(await getPortStatus(entry.port, entry.service));
  }
  const occupied = statuses.filter((status) => status.occupied);
  if (occupied.length > 0) {
    const lines = ['SCC-Batch port preflight failed.'];
    for (const status of occupied) {
      const occupant = status.occupant;
      lines.push(
        `- Port ${status.port} is already in use by ${occupant?.processName ?? 'another process'}${occupant?.pid ? ` (PID ${occupant.pid})` : ''}. ${status.service} needs this port.`
      );
    }
    lines.push('Please free the occupied port and try again.');
    const error = new Error(lines.join('\n'));
    error.name = 'PortPreflightError';
    throw error;
  }
  return statuses;
}
