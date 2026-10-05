import { spawn } from 'node:child_process';

export function runProcess(file, args, options = {}) {
  const { timeoutMs = 120_000, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} a dépassé ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export async function checkedProcess(file, args, options = {}) {
  const result = await runProcess(file, args, options);
  if (result.code !== 0) {
    const error = new Error(`${file} ${args.join(' ')} a échoué avec le code ${result.code}`);
    error.result = result;
    throw error;
  }
  return result;
}
