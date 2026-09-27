import fs from 'fs/promises';

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function timeout(ms, label) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms));
}

/**
 * Safely move a downloaded file to target path, falling back to copy if locked by Windows process.
 */
export async function safeMoveOrCopy(fromPath, toPath) {
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rename(fromPath, toPath);
      return;
    } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && i < 4) {
        await sleep(400);
        continue;
      }
    }
  }

  // Fall back to copyFile
  console.log(`Note: File is locked by an external process. Using copy fallback...`);
  await fs.copyFile(fromPath, toPath);
  try {
    await fs.unlink(fromPath);
  } catch (_) {}
}

/**
 * Clean up leftover default named CSV files in a directory.
 */
export async function cleanupStaleFiles(dir, pattern) {
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      const isMatch = typeof pattern === 'string' ? f.includes(pattern) : pattern.test(f);
      if (isMatch && f.endsWith('.csv')) {
        try {
          await fs.unlink(`${dir}/${f}`);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

export class BiDiClient {
  constructor(port = 9222) {
    this.url = `ws://127.0.0.1:${port}/session`;
    this.msgId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch (err) {
        console.error('Error parsing BiDi message:', err);
      }
    };
  }

  send(method, params = {}, timeoutMs = 25000) {
    const id = this.msgId++;
    const p = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    return Promise.race([p, timeout(timeoutMs, method)]);
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }

  async initialize(downloadDir) {
    await this.connect();
    await this.send('session.new', { capabilities: {} });
    await this.send('browser.setDownloadBehavior', {
      downloadBehavior: { type: 'allowed', destinationFolder: downloadDir }
    });

    const treeRes = await this.send('browsingContext.getTree', {});
    const contexts = treeRes.result?.contexts || [];
    const cloverTab = contexts.find(c => c.url && c.url.includes('clover.com'));
    if (!cloverTab) {
      throw new Error('Clover tab not found! Please open Clover in Firefox.');
    }

    // Extract Merchant ID from active Clover tab or environment variable
    let merchantId = process.env.CLOVER_MERCHANT_ID || '';
    try {
      const u = new URL(cloverTab.url);
      const qMid = u.searchParams.get('mid');
      if (qMid) {
        merchantId = qMid;
      } else {
        const pathMatch = u.pathname.match(/\/m\/([A-Za-z0-9]+)/);
        if (pathMatch) merchantId = pathMatch[1];
      }
    } catch (_) {}

    if (!merchantId) {
      throw new Error(
        'Merchant ID could not be detected. Please ensure an active Clover tab is open or set CLOVER_MERCHANT_ID.'
      );
    }

    return { cloverTab, merchantId };
  }
}
