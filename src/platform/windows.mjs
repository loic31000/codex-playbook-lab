import { spawn } from 'node:child_process';

export async function stopProcessTree(pid) {
  if (!pid) return { ok: true, alreadyExited: true };
  return new Promise((resolve) => {
    let stdout = ''; let stderr = '';
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    killer.stdout.setEncoding('utf8'); killer.stderr.setEncoding('utf8');
    killer.stdout.on('data', (chunk) => { stdout += chunk; });
    killer.stderr.on('data', (chunk) => { stderr += chunk; });
    killer.once('error', (error) => resolve({ ok: false, alreadyExited: false, error: error.message, stdout, stderr }));
    killer.once('close', (code) => {
      const diagnostic = `${stdout}\n${stderr}`;
      const alreadyExited = code !== 0 && /(not found|no running instance|introuvable|aucune instance)/i.test(diagnostic);
      resolve({ ok: code === 0 || alreadyExited, alreadyExited, code, stdout, stderr });
    });
  });
}

export const childOptions = { detached: false, windowsHide: true };
