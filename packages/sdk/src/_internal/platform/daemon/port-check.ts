/**
 * Check if a TCP port is available before attempting to bind.
 * Returns true if the port is free, false if it's in use.
 */
export async function isPortAvailable(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          socket.end();
          resolve(false);
        },
        error() {
          resolve(true);
        },
        data() {},
        close() {},
      },
    }).catch(() => {
      // Connection refused — port is free
      resolve(true);
    });
  });
}

/**
 * Check port availability and throw a clear error if it's in use.
 */
export async function requirePortAvailable(
  port: number,
  host = '0.0.0.0',
  label = 'server',
): Promise<void> {
  const available = await isPortAvailable(port, host);
  if (!available) {
    throw new Error(
      `Port ${port} is already in use. Cannot start ${label}. ` +
        `Check if another instance is running or use a different port.`,
    );
  }
}
