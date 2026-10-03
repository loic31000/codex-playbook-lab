const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
const code = (n, text) => enabled ? `\x1b[${n}m${text}\x1b[0m` : text;
export const colors = {
  cyan: (s) => code(36, s), green: (s) => code(32, s), yellow: (s) => code(33, s),
  red: (s) => code(31, s), gray: (s) => code(90, s), magenta: (s) => code(35, s),
};
export function banner() {
  console.log(colors.cyan('╔════════════════════════════════════════════════════════════╗'));
  console.log(colors.cyan('║  CODEX PLAYBOOK LAB                                       ║'));
  console.log(colors.gray('║  Prompt testing & validation                              ║'));
  console.log(colors.cyan('╚════════════════════════════════════════════════════════════╝'));
}
export function ok(message) { console.log(colors.green(`  ✓ ${message}`)); }
export function warn(message) { console.log(colors.yellow(`  ! ${message}`)); }
export function fail(message) { console.error(colors.red(`  ✗ ${message}`)); }
export function step(label, message = '') { console.log(colors.cyan(`\n  [${label}]${message ? ` ${message}` : ''}`)); }
