import type { StrictExecutionEnvironment, StrictEnvironmentFacts } from "./strict-runner.js";

export type ProbeStatus = "blocked" | "reachable" | "not_proven";

export interface StrictSentinel {
  readonly name: string;
  readonly content: string;
}

export interface StrictIsolationProbe {
  readonly targetReadable: boolean;
  readonly targetWritable: boolean;
  readonly labSentinelMatches: readonly string[];
  readonly labSentinelContentMatches: readonly string[];
  readonly hostHomeVisible: boolean;
  readonly dockerSocketVisible: boolean;
  readonly network: {
    readonly networkMode: string;
    readonly publishedPorts: Readonly<Record<string, unknown>>;
    readonly interfaces: readonly string[];
    readonly nonLoopbackInterfaces: readonly string[];
    readonly externalRoutes: ProbeStatus;
    readonly hostDockerInternal: ProbeStatus;
    readonly gatewayDockerInternal: ProbeStatus;
    readonly externalDns: ProbeStatus;
    readonly isolated: boolean;
  };
  readonly environmentNames: readonly string[];
  readonly secretEnvironmentNames: readonly string[];
}

function lines(value: string): readonly string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function assertSentinel(value: StrictSentinel): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value.name)) throw new TypeError("sentinel name is unsafe");
  if (!/^[A-Z0-9_]+$/.test(value.content)) throw new TypeError("sentinel content is unsafe");
}

async function commandOk(environment: StrictExecutionEnvironment, command: string): Promise<boolean> {
  return (await environment.exec(["sh", "-lc", command], { timeoutMs: 30_000 })).code === 0;
}

async function findName(environment: StrictExecutionEnvironment, name: string): Promise<readonly string[]> {
  const result = await environment.exec([
    "find", "/", "-path", "/proc", "-prune", "-o", "-path", "/sys", "-prune", "-o",
    "-path", "/dev", "-prune", "-o", "-type", "f", "-name", name, "-print",
  ], { timeoutMs: 60_000 });
  return lines(result.stdout);
}

async function findContent(environment: StrictExecutionEnvironment, content: string): Promise<readonly string[]> {
  const result = await environment.exec([
    "sh", "-lc",
    `find / \\( -path /proc -o -path /sys -o -path /dev -o -path /run \\) -prune -o -type f -readable -print0 2>/dev/null | xargs -0 -r grep -l -F -- '${content}' 2>/dev/null`,
  ], { timeoutMs: 120_000 });
  return lines(result.stdout);
}

const NETWORK_SCRIPT = String.raw`
const dns = require('node:dns').promises;
const os = require('node:os');
const fs = require('node:fs');
async function resolve(hostname) {
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'not_proven' }), 3000); });
    const lookup = dns.lookup(hostname).then(() => ({ status: 'reachable' })).catch((error) => {
      return ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(error.code)
        ? { status: 'blocked' }
        : { status: 'not_proven' };
    });
    return await Promise.race([lookup, timeout]);
  } finally { clearTimeout(timer); }
}
(async () => {
  const interfaces = os.networkInterfaces();
  const nonLoopback = Object.entries(interfaces).flatMap(([name, addresses]) => addresses.filter((address) => !address.internal).map(() => name));
  const ipv4 = fs.readFileSync('/proc/net/route', 'utf8').trim().split(/\r?\n/).slice(1).filter((line) => !line.startsWith('lo\t'));
  const ipv6 = fs.readFileSync('/proc/net/ipv6_route', 'utf8').trim().split(/\r?\n/).filter((line) => line && !line.endsWith(' lo'));
  process.stdout.write(JSON.stringify({
    interfaces: Object.keys(interfaces).sort(),
    nonLoopback: [...new Set(nonLoopback)].sort(),
    externalRoutes: ipv4.length || ipv6.length ? 'reachable' : 'blocked',
    host: await resolve('host.docker.internal'),
    gateway: await resolve('gateway.docker.internal'),
    external: await resolve('example.com'),
  }));
})().catch(() => process.stdout.write(JSON.stringify({ status: 'not_proven' })));
`;

export async function probeStrictEnvironment(
  environment: StrictExecutionEnvironment,
  options: { readonly sentinels?: readonly StrictSentinel[] } = {},
): Promise<StrictIsolationProbe> {
  const sentinels = options.sentinels ?? [];
  sentinels.forEach(assertSentinel);
  const facts: StrictEnvironmentFacts = await environment.facts();
  const targetReadable = await commandOk(environment, "test -r /workspace");
  const targetWritable = await commandOk(
    environment,
    "probe=/workspace/.strict-write-probe-$$; printf probe > \"$probe\" && rm -f \"$probe\"",
  );
  const labSentinelMatches = (await Promise.all(sentinels.map((sentinel) => findName(environment, sentinel.name)))).flat();
  const labSentinelContentMatches = (
    await Promise.all(sentinels.map((sentinel) => findContent(environment, sentinel.content)))
  ).flat();
  const networkResult = await environment.exec(["node", "-e", NETWORK_SCRIPT], { timeoutMs: 15_000 });
  const network = networkResult.code === 0
    ? JSON.parse(networkResult.stdout) as {
      interfaces?: string[];
      nonLoopback?: string[];
      externalRoutes?: ProbeStatus;
      host?: { status: ProbeStatus };
      gateway?: { status: ProbeStatus };
      external?: { status: ProbeStatus };
      status?: ProbeStatus;
    }
    : { status: "not_proven" as const };
  const externalRoutes = network.externalRoutes ?? "not_proven";
  const hostDockerInternal = network.host?.status ?? "not_proven";
  const gatewayDockerInternal = network.gateway?.status ?? "not_proven";
  const externalDns = network.external?.status ?? "not_proven";
  const interfaces = network.interfaces ?? [];
  const nonLoopbackInterfaces = network.nonLoopback ?? [];
  return {
    targetReadable,
    targetWritable,
    labSentinelMatches,
    labSentinelContentMatches,
    hostHomeVisible: await commandOk(environment, "test -d /host -o -d /mnt/host -o -d /run/desktop/mnt/host"),
    dockerSocketVisible: await commandOk(environment, "test -e /var/run/docker.sock"),
    network: {
      networkMode: facts.networkMode,
      publishedPorts: facts.publishedPorts,
      interfaces,
      nonLoopbackInterfaces,
      externalRoutes,
      hostDockerInternal,
      gatewayDockerInternal,
      externalDns,
      isolated: facts.networkMode === "none"
        && Object.keys(facts.publishedPorts).length === 0
        && nonLoopbackInterfaces.length === 0
        && externalRoutes === "blocked"
        && hostDockerInternal === "blocked"
        && gatewayDockerInternal === "blocked"
        && externalDns === "blocked",
    },
    environmentNames: facts.environmentNames,
    secretEnvironmentNames: facts.secretEnvironmentNames,
  };
}
