export async function stopProcessTree(pid) {
  if (!pid) return { ok: true, alreadyExited: true };
  try { process.kill(-pid, 'SIGTERM'); } catch (error) {
    if (error.code === 'ESRCH') return { ok: true, alreadyExited: true };
    return { ok: false, alreadyExited: false, error: error.message, code: error.code };
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (error.code !== 'ESRCH') return { ok: false, alreadyExited: false, error: error.message, code: error.code };
  }
  return { ok: true, alreadyExited: false };
}

export const childOptions = { detached: true };
