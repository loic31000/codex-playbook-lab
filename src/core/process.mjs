import { spawn } from 'node:child_process';

export function run(command, args = [], options = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let executable = command; let executableArgs = args;
    // npm/npx are batch shims on Windows; cmd.exe is required for those two
    // trusted tool names. Codex itself is always spawned directly.
    if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
      executable = process.env.ComSpec || 'cmd.exe';
      executableArgs = ['/d', '/s', '/c', command, ...args];
    }
    const child = spawn(executable, executableArgs, {
      cwd: options.cwd,
      env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('error', (error) => resolve({ code: null, signal: null, stdout, stderr, error }));
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, error: null }));
  });
}

export async function runChecked(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} a échoué (${result.code ?? 'unknown'}) : ${result.stderr.trim()}`);
  return result;
}

export const git = (args, options = {}) => run('git', ['--no-pager', ...args], options);
