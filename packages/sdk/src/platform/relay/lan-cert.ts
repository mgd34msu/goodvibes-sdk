// relay/lan-cert.ts
//
// A helper that mints a local certificate authority and a leaf certificate for
// the daemon's LAN endpoints, so browsers reaching the daemon over the LAN (or,
// with the CA trusted, over the relay-bridged surfaces) stop throwing TLS
// warnings. Scope, stated honestly:
//   * GENERATE — mint a CA + a SAN leaf cert for the given hostnames/IPs.
//   * STORE    — write ca-cert/ca-key/lan-cert/lan-key into the daemon home.
//   * SERVE    — the returned cert/key paths plug straight into the existing
//                controlPlane.tls config (mode 'direct', certFile/keyFile).
// TRUSTING the minted CA on the operating system (so the browser accepts it) is
// explicitly the USER's step — this helper never touches the OS trust store, and
// the docs say so.
//
// Certificate generation is delegated to `openssl` (ubiquitous, audited) through
// an injected command runner; we do not hand-roll ASN.1/X.509. When openssl is
// absent the helper fails with a clear, honest error rather than a broken cert.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Runs an external command. Injected so the orchestration is unit-testable. */
export interface LanCertCommandRunner {
  run(command: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

/** Minimal filesystem surface, injected for tests. */
export interface LanCertFs {
  mkdirp(dir: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface MintLanCertificateOptions {
  /** Directory to store the CA and leaf material in. */
  readonly dir: string;
  /** DNS names to include as SANs (e.g. daemon.local, the machine hostname). */
  readonly hostnames?: readonly string[];
  /** IP addresses to include as SANs (e.g. the LAN IP, 127.0.0.1). */
  readonly ipAddresses?: readonly string[];
  /** Certificate validity in days (default 825 — the browser-accepted maximum). */
  readonly validityDays?: number;
  /** openssl executable (default 'openssl'). */
  readonly opensslPath?: string;
  /** Leaf certificate common name (default 'GoodVibes Daemon'). */
  readonly commonName?: string;
  /** Regenerate even if material already exists (default false → reuse). */
  readonly force?: boolean;
}

export interface LanCertificateResult {
  /** The CA certificate the USER must trust on their OS/browser (their step). */
  readonly caCertPath: string;
  /** Leaf certificate to serve (controlPlane.tls.certFile). */
  readonly certPath: string;
  /** Leaf private key to serve (controlPlane.tls.keyFile). */
  readonly keyPath: string;
  /** True when existing material was found and left intact. */
  readonly reused: boolean;
}

export interface LanCertDeps {
  readonly runner?: LanCertCommandRunner;
  readonly fs?: LanCertFs;
}

const defaultRunner: LanCertCommandRunner = {
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`"${command}" was not found. Install openssl to mint LAN certificates.`));
          return;
        }
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    }),
};

const defaultFs: LanCertFs = {
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: async (path, data) => {
    await writeFile(path, data, 'utf8');
  },
  exists: async (path) => {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  },
};

function sanConfig(hostnames: readonly string[], ipAddresses: readonly string[]): string {
  const entries: string[] = [];
  hostnames.forEach((h, i) => entries.push(`DNS.${i + 1} = ${h}`));
  ipAddresses.forEach((ip, i) => entries.push(`IP.${i + 1} = ${ip}`));
  return `[v3_req]\nsubjectAltName = @alt_names\n\n[alt_names]\n${entries.join('\n')}\n`;
}

/**
 * Mint (or reuse) a LAN CA + leaf certificate. Returns the paths to serve and
 * the CA the user must trust. Throws a clear error if openssl is unavailable or
 * any step fails.
 */
export async function mintLanCertificate(options: MintLanCertificateOptions, deps: LanCertDeps = {}): Promise<LanCertificateResult> {
  const runner = deps.runner ?? defaultRunner;
  const fs = deps.fs ?? defaultFs;
  const openssl = options.opensslPath ?? 'openssl';
  const days = String(options.validityDays ?? 825);
  const cn = options.commonName ?? 'GoodVibes Daemon';
  const hostnames = options.hostnames ?? ['daemon.local', 'localhost'];
  const ipAddresses = options.ipAddresses ?? ['127.0.0.1'];

  const caKeyPath = join(options.dir, 'ca-key.pem');
  const caCertPath = join(options.dir, 'ca-cert.pem');
  const keyPath = join(options.dir, 'lan-key.pem');
  const certPath = join(options.dir, 'lan-cert.pem');
  const csrPath = join(options.dir, 'lan.csr');
  const sanPath = join(options.dir, 'lan-san.cnf');

  if (!options.force && (await fs.exists(caCertPath)) && (await fs.exists(certPath)) && (await fs.exists(keyPath))) {
    return { caCertPath, certPath, keyPath, reused: true };
  }

  await fs.mkdirp(options.dir);
  await fs.writeFile(sanPath, sanConfig(hostnames, ipAddresses));

  const steps: Array<readonly string[]> = [
    // 1. CA key + self-signed CA certificate (P-256).
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', caKeyPath, '-out', caCertPath, '-days', days, '-subj', `/CN=${cn} LAN CA`],
    // 2. Leaf key (P-256).
    ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath],
    // 3. Leaf CSR.
    ['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', `/CN=${cn}`],
    // 4. Sign the leaf with the CA, attaching the SAN extension.
    ['x509', '-req', '-in', csrPath, '-CA', caCertPath, '-CAkey', caKeyPath, '-CAcreateserial', '-out', certPath, '-days', days, '-extfile', sanPath, '-extensions', 'v3_req'],
  ];

  for (const args of steps) {
    const result = await runner.run(openssl, args);
    if (result.code !== 0) {
      throw new Error(`openssl ${args[0]} failed (exit ${result.code}): ${result.stderr.trim() || 'unknown error'}`);
    }
  }

  return { caCertPath, certPath, keyPath, reused: false };
}
